import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compactDecrypt, decodeProtectedHeader } from 'jose';
import type { Config } from '../../config';
import { type Logger, silentLogger } from '../../utils/logger';
import { supportedScopes } from '../oauth-scopes';
import { configDir } from '../token-persistence';
import { createExpiringMap } from './expiring-map';
import type { RecordStore } from './file-store';
import { createInteractionRoutes } from './interactions';
import { deriveKeyRing, type KeyRing } from './keys';
import { ACCESS_TOKEN_TTL_S, buildProvider } from './provider';
import { resolveMasterSecret } from './secret';
import { createAdapterFactory, createSealedCollection, openStore } from './store';
import { type Fetch, trustedClientSet } from './trusted-clients';
import type { ZendeskTokenSet } from './upstream';
import { createZendeskGrants, ZENDESK_REFRESH_MARGIN_MS } from './zendesk-grant';

export interface VerifiedAccessToken {
  readonly zendeskAccessToken: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly subject: string;
  /** Epoch seconds. */
  readonly expiresAt: number;
}

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: string[];
  readonly bearer_methods_supported: string[];
  readonly scopes_supported: string[];
}

export interface AuthorizationServer {
  readonly issuer: string;
  readonly resource: string;
  readonly protectedResourceMetadata: ProtectedResourceMetadata;
  /** Every route that is neither `/mcp`, the protected-resource metadata nor `/healthz`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Our JWE, decrypted and checked (issuer, audience, expiry, revocation), or `undefined`. */
  verifyAccessToken(bearer: string): Promise<VerifiedAccessToken | undefined>;
  /** Zendesk refused this grant's token: end the grant so the client signs in again. */
  revokeGrant(grantId: string): Promise<void>;
}

export interface AuthorizationServerOptions {
  readonly config: Config;
  /** The public base URL (no trailing slash): our issuer. */
  readonly issuer: string;
  readonly ring: KeyRing;
  readonly persistent: RecordStore;
  readonly isAllowedOrigin: (origin: string) => boolean;
  readonly logger?: Logger | undefined;
  /** Base fetch for CIMD documents (tests). */
  readonly fetch?: Fetch | undefined;
}

const decoder = new TextDecoder();

interface AccessTokenClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  sub?: unknown;
  client_id?: unknown;
  zd?: unknown;
  gid?: unknown;
}

const asVerified = (
  claims: AccessTokenClaims,
  issuer: string,
  resource: string,
): VerifiedAccessToken | undefined => {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const valid =
    claims.iss === issuer &&
    audiences.includes(resource) &&
    typeof claims.exp === 'number' &&
    claims.exp * 1000 > Date.now() &&
    typeof claims.zd === 'string' &&
    typeof claims.gid === 'string';
  if (!valid) return undefined;
  return {
    zendeskAccessToken: claims.zd as string,
    grantId: claims.gid as string,
    clientId: String(claims.client_id),
    subject: String(claims.sub),
    expiresAt: claims.exp as number,
  };
};

export const createAuthorizationServer = (
  options: AuthorizationServerOptions,
): AuthorizationServer => {
  const { config, issuer, ring, persistent } = options;
  const logger = options.logger ?? silentLogger;
  const resource = `${issuer}/mcp`;
  const upstream = { subdomain: config.subdomain, clientId: config.oauthClientId };

  const zendeskGrants = createZendeskGrants({
    records: createSealedCollection<ZendeskTokenSet>(persistent, 'ZendeskTokens', ring),
    upstream,
    logger,
    // A token we mint carries the Zendesk token for its whole life.
    refreshMarginMs: ACCESS_TOKEN_TTL_S * 1000 + ZENDESK_REFRESH_MARGIN_MS,
  });

  const provider = buildProvider({
    issuer,
    resource,
    ring,
    adapter: createAdapterFactory({ persistent }, ring),
    zendeskGrants,
    allowWrite: !config.readOnly,
    isAllowedOrigin: options.isAllowedOrigin,
    // Only an HTTPS public URL implies a TLS-terminating proxy whose
    // X-Forwarded-* headers are to be trusted.
    behindProxy: config.publicUrl?.startsWith('https:') === true,
    fetch: options.fetch,
  });
  provider.on('server_error', (_ctx, err) => {
    logger.error('oauth_server_error', { error: err.message });
  });

  const interactions = createInteractionRoutes({
    provider,
    upstream,
    issuer,
    readOnly: config.readOnly,
    zendeskGrants,
    consentMemory: createSealedCollection<true>(persistent, 'Consent', ring),
    trustedClients: trustedClientSet(config.oauthTrustedClients, config.defaultTrustedClients),
    logger,
  });
  const callback = provider.callback();

  // Grants revoked after a Zendesk 401: their still-unexpired access tokens are
  // refused until they would have expired anyway. In memory, like the sessions.
  const revokedGrants = createExpiringMap<true>();

  // Rejects on anything that is not one of our JWEs.
  const readAccessToken = async (bearer: string): Promise<VerifiedAccessToken | undefined> => {
    const { kid } = decodeProtectedHeader(bearer);
    const keySet = ring.find((set) => set.accessToken.kid === kid);
    // Stryker disable next-line ConditionalExpression: without it, reading the missing key set throws
    // into the same undefined; the always-refuse sibling is killed.
    if (!keySet) return undefined;
    const { plaintext } = await compactDecrypt(bearer, keySet.accessToken.key);
    return asVerified(JSON.parse(decoder.decode(plaintext)) as AccessTokenClaims, issuer, resource);
  };

  return {
    issuer,
    resource,
    protectedResourceMetadata: {
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: supportedScopes(config.readOnly),
    },
    handle: async (req, res) => {
      // Stryker disable next-line StringLiteral: a request reaching a node:http server always has req.url.
      const url = new URL(req.url ?? '/', issuer);
      if (url.pathname === '/oauth/callback' && req.method === 'GET') {
        interactions.upstreamCallback(res, url);
        return;
      }
      if (url.pathname.startsWith('/interaction/')) {
        await interactions.handle(req, res, url);
        return;
      }
      await callback(req, res);
    },
    verifyAccessToken: async (bearer) => {
      const verified = await readAccessToken(bearer).catch(() => undefined);
      return verified && !revokedGrants.get(verified.grantId) ? verified : undefined;
    },
    // Never rejects: it runs fire-and-forget from a tool call's 401, where an
    // unhandled rejection would take the process down. The in-memory denial
    // lands first, so the grant's tokens stop working even if the store fails.
    revokeGrant: async (grantId) => {
      revokedGrants.set(grantId, true, ACCESS_TOKEN_TTL_S * 1000);
      try {
        const grant = await provider.Grant.find(grantId);
        await Promise.all([
          grant?.destroy(),
          provider.RefreshToken.adapter.revokeByGrantId(grantId),
          zendeskGrants.remove(grantId),
        ]);
        logger.info('oauth_grant_revoked', { reason: 'zendesk_unauthorized' });
      } catch (err) {
        logger.warn('oauth_grant_revoke_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
};

/**
 * Resolve the master secret and open the store, before the HTTP port is bound:
 * a short supplied secret or an unusable store stops startup here. Returns the
 * builder to call once the public URL (issuer) is known.
 */
export const prepareAuthorizationServer = async (
  config: Config,
  logger: Logger = silentLogger,
): Promise<
  (
    issuer: string,
    isAllowedOrigin: (origin: string) => boolean,
    overrides?: { fetch?: Fetch | undefined },
  ) => AuthorizationServer
> => {
  const dir = configDir();
  const storeUri = config.oauthStore ?? pathToFileURL(join(dir, 'oauth-store.json')).href;
  const secret = resolveMasterSecret(
    {
      value: config.oauthMasterSecret,
      file: config.oauthMasterSecretFile,
      configDir: dir,
      storeUri,
    },
    logger,
  );
  const ring = deriveKeyRing(secret.value);
  const persistent = openStore(storeUri);
  return (issuer, isAllowedOrigin, overrides = {}) =>
    createAuthorizationServer({
      config,
      issuer,
      ring,
      persistent,
      isAllowedOrigin,
      logger,
      fetch: overrides.fetch,
    });
};
