import Provider, { type Configuration, errors, interactionPolicy } from 'oidc-provider';
import { renderErrorPage } from './consent';
import type { KeyRing } from './keys';
import { createCimdFetch, type Fetch } from './trusted-clients';
import { isGrantUnavailableError, type ZendeskGrants } from './zendesk-grant';

// Our access tokens are short so a revocation at Zendesk (or of the grant)
// bites quickly; refresh tokens and grants last as long as Zendesk's refresh
// token can (ADR, constraint 4).
export const ACCESS_TOKEN_TTL_S = 3600;
export const GRANT_TTL_S = 90 * 86400;
// A browser sign-in, remembered across authorizations of the same browser.
// Matches the longest Zendesk agent session (12 h); in memory anyway.
const SESSION_TTL_S = 12 * 3600;
const INTERACTION_TTL_S = 10 * 60;

/** Scopes the server advertises and grants; `offline_access` is for clients (ChatGPT) that ask for it. */
export const RESOURCE_SCOPES = ['read', 'write'] as const;

export interface ProviderOptions {
  readonly issuer: string;
  /** The canonical `/mcp` resource: the only audience our tokens carry. */
  readonly resource: string;
  readonly ring: KeyRing;
  readonly adapter: NonNullable<Configuration['adapter']>;
  readonly zendeskGrants: ZendeskGrants;
  /** `false` narrows the grantable scopes to `read`, like `--read-only` narrows the tool surface. */
  readonly allowWrite: boolean;
  /** CORS for the provider's own endpoints: the same allowlist as `/mcp`. */
  readonly isAllowedOrigin: (origin: string) => boolean;
  /** Trust `X-Forwarded-*` (a TLS-terminating proxy in front). */
  readonly behindProxy: boolean;
  /** Base fetch for CIMD documents; tests inject one. oidc-provider's SSRF guard rides in its options. */
  readonly fetch?: Fetch | undefined;
}

// Every authorization goes through Zendesk, even with a live browser session:
// each grant needs its own fresh Zendesk tokens. The check lets the login that
// just happened in this very authorization through, or it would loop.
const policyWithUpstreamLogin = () => {
  const policy = interactionPolicy.base();
  policy
    .get('login')
    ?.checks.add(
      new interactionPolicy.Check(
        'upstream_login_required',
        'every authorization signs in to Zendesk again',
        (ctx) =>
          ctx.oidc.result?.['login'] === undefined
            ? interactionPolicy.Check.REQUEST_PROMPT
            : interactionPolicy.Check.NO_NEED_TO_PROMPT,
      ),
    );
  return policy;
};

export const buildProvider = (options: ProviderOptions): Provider => {
  const { ring, resource } = options;
  const [current] = ring;
  const scopes = options.allowWrite ? RESOURCE_SCOPES.join(' ') : 'read';
  const baseFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  const provider = new Provider(options.issuer, {
    adapter: options.adapter,
    // Never the library defaults: DEV_KEYSTORE is public and empty cookie keys
    // leave cookies unsigned (ADR, Keys and secrets).
    jwks: { keys: ring.map((set) => set.signingJwk) },
    cookies: { keys: ring.map((set) => set.cookieKey) },
    clients: [],
    fetch: createCimdFetch(baseFetch),
    scopes: options.allowWrite
      ? [...RESOURCE_SCOPES, 'offline_access']
      : ['read', 'offline_access'],
    clientDefaults: {
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      // The only signing key is Ed25519; the RS256 default makes DCR fail.
      id_token_signed_response_alg: 'EdDSA',
    },
    // Authorization code only: no implicit or hybrid flow to advertise or accept.
    responseTypes: ['code'],
    clientAuthMethods: ['none', 'private_key_jwt', 'client_secret_basic', 'client_secret_post'],
    clientBasedCORS: (_ctx, origin) => options.isAllowedOrigin(origin),
    pkce: { required: () => true },
    // Refresh tokens without `offline_access`: MCP clients do not all ask for
    // it. Not tied to the session, which lives in memory (ADR, Tokens).
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    expiresWithSession: async () => false,
    ttl: {
      AccessToken: ACCESS_TOKEN_TTL_S,
      AuthorizationCode: 60,
      Grant: GRANT_TTL_S,
      Interaction: INTERACTION_TTL_S,
      RefreshToken: GRANT_TTL_S,
      Session: SESSION_TTL_S,
    },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      clientIdMetadataDocument: {
        enabled: true,
        ack: 'draft-02',
        // SSRF (special-use IPs, redirects, size, time) is guarded by the
        // library's fetch; this only pins the scheme and port.
        allowFetch: async (_ctx, clientId) => {
          const url = new URL(clientId);
          return url.protocol === 'https:' && (url.port === '' || url.port === '443');
        },
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, indicator) => {
          if (indicator !== resource) throw new errors.InvalidTarget();
          return {
            scope: scopes,
            audience: resource,
            accessTokenTTL: ACCESS_TOKEN_TTL_S,
            accessTokenFormat: 'jwt',
            // Encrypt-only: authenticated encryption with a symmetric key needs
            // no separate signature, and hides the Zendesk token inside.
            jwt: {
              encrypt: {
                alg: 'dir',
                enc: 'A256GCM',
                key: current.accessToken.key,
                kid: current.accessToken.kid,
              },
            },
          };
        },
      },
    },
    extraTokenClaims: async (_ctx, token) => {
      if (token.kind !== 'AccessToken' || !token.grantId) return undefined;
      try {
        return { zd: await options.zendeskGrants.accessToken(token.grantId), gid: token.grantId };
      } catch (err) {
        if (isGrantUnavailableError(err)) {
          // biome-ignore lint/style/useErrorCause: oidc-provider errors take the cause inside their one options argument, which the rule does not read.
          throw new errors.InvalidGrant({
            detail: 'the Zendesk authorization behind this grant is no longer valid',
            cause: err,
          });
        }
        throw err;
      }
    },
    findAccount: async (_ctx, sub) => ({ accountId: sub, claims: async () => ({ sub }) }),
    // A fresh grant per authorization, created by our consent step with the
    // Zendesk tokens of that very sign-in: never one remembered by the session.
    loadExistingGrant: async (ctx) => {
      const grantId = ctx.oidc.result?.['consent']?.grantId;
      return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined;
    },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
      policy: policyWithUpstreamLogin(),
    },
    renderError: async (ctx, out) => {
      ctx.type = 'html';
      ctx.body = renderErrorPage(
        'Sign-in failed',
        `${out['error'] ?? 'error'}: ${out['error_description'] ?? 'the authorization request was rejected'}`,
      );
    },
  });
  provider.proxy = options.behindProxy;
  return provider;
};
