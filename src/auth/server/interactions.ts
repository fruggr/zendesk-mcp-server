import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Provider from 'oidc-provider';
import { type Logger, silentLogger } from '../../utils/logger';
import { generateCodeChallenge, generateCodeVerifier } from '../browser-oauth';
import { requestedScope } from '../oauth-scopes';
import { renderConsentPage, renderErrorPage } from './consent';
import { createExpiringMap } from './expiring-map';
import type { SealedCollection } from './store';
import { canSkipConsent } from './trusted-clients';
import {
  buildZendeskAuthorizeUrl,
  exchangeZendeskCode,
  fetchZendeskIdentity,
  isUpstreamAuthError,
  type ZendeskTokenSet,
  type ZendeskUpstream,
} from './upstream';
import type { ZendeskGrants } from './zendesk-grant';

// Pending state lives for one sign-in at most: the interaction's own lifetime.
const PENDING_TTL_MS = 10 * 60 * 1000;
// A remembered consent is asked for again after this long, or as soon as the
// client's redirect URIs change.
export const CONSENT_MEMORY_TTL_S = 90 * 86400;

export interface InteractionDeps {
  readonly provider: Provider;
  readonly upstream: ZendeskUpstream;
  readonly issuer: string;
  readonly readOnly: boolean;
  readonly zendeskGrants: ZendeskGrants;
  readonly consentMemory: SealedCollection<true>;
  readonly trustedClients: ReadonlySet<string>;
  readonly logger?: Logger | undefined;
}

const sendHtml = (res: ServerResponse, status: number, html: string): void => {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
};

const redirect = (res: ServerResponse, location: string): void => {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
};

const EXPIRED =
  'This sign-in has expired or was opened in another browser. Start the connection again from your MCP client.';

export const consentMemoryKey = (
  accountId: string,
  clientId: string,
  redirectUris: readonly string[],
): string =>
  createHash('sha256')
    .update(JSON.stringify([accountId, clientId, [...redirectUris].sort()]))
    .digest('base64url');

// oidc-provider throws these on a missing or foreign interaction cookie: an
// expired link, not a server fault.
const isExpiredLink = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'SessionNotFound' || err.name === 'InvalidRequest');

// Uids are nanoids; anything else did not come from oidc-provider.
const UID = /^[\w-]{1,64}$/;

/**
 * The login and consent steps oidc-provider hands off to us. Login is always a
 * round trip to Zendesk (fresh tokens for every grant); consent is skipped for
 * trusted CIMD clients and for a client this user already approved with the
 * same redirect URIs, and shown otherwise (ADR, Consent).
 */
export const createInteractionRoutes = (deps: InteractionDeps) => {
  const { provider, upstream, issuer } = deps;
  const logger = deps.logger ?? silentLogger;
  const callbackUrl = `${issuer}/oauth/callback`;
  const verifiers = createExpiringMap<string>();
  const upstreamTokens = createExpiringMap<ZendeskTokenSet>();

  type Details = Awaited<ReturnType<Provider['interactionDetails']>>;

  const finish = (req: IncomingMessage, res: ServerResponse, result: Record<string, unknown>) =>
    provider.interactionFinished(req, res, result, { mergeWithLastSubmission: true });

  const deny = (req: IncomingMessage, res: ServerResponse, description: string) =>
    finish(req, res, { error: 'access_denied', error_description: description });

  const startUpstreamLogin = (res: ServerResponse, uid: string): void => {
    const verifier = generateCodeVerifier();
    verifiers.set(uid, verifier, PENDING_TTL_MS);
    redirect(
      res,
      buildZendeskAuthorizeUrl(upstream, {
        redirectUri: callbackUrl,
        scope: requestedScope(deps.readOnly),
        state: uid,
        codeChallenge: generateCodeChallenge(verifier),
      }),
    );
  };

  const approve = async (
    req: IncomingMessage,
    res: ServerResponse,
    details: Details,
    { accountId, clientId }: { accountId: string; clientId: string },
    tokens: ZendeskTokenSet,
  ): Promise<void> => {
    const grant = new provider.Grant({ accountId, clientId });
    const missing = details.prompt.details as {
      missingOIDCScope?: string[];
      missingResourceScopes?: Record<string, string[]>;
    };
    if (missing.missingOIDCScope?.length) grant.addOIDCScope(missing.missingOIDCScope.join(' '));
    for (const [indicator, scopes] of Object.entries(missing.missingResourceScopes ?? {})) {
      grant.addResourceScope(indicator, scopes.join(' '));
    }
    const grantId = await grant.save();
    await deps.zendeskGrants.save(grantId, tokens);
    logger.info('oauth_grant_created', { clientId });
    await finish(req, res, { consent: { grantId } });
  };

  const consentContext = async (details: Details) => {
    const accountId = String(details.session?.accountId);
    const clientId = String(details.params['client_id']);
    const client = await provider.Client.find(clientId);
    const redirectUris = client?.redirectUris ?? [];
    return {
      client,
      accountId,
      clientId,
      pendingKey: `${accountId}|${clientId}`,
      memoryKey: consentMemoryKey(accountId, clientId, redirectUris),
      redirectUri: String(details.params['redirect_uri']),
      redirectUris,
    };
  };

  const showInteraction = async (req: IncomingMessage, res: ServerResponse, uid: string) => {
    const details = await provider.interactionDetails(req, res);
    if (details.prompt.name === 'login') {
      startUpstreamLogin(res, uid);
      return;
    }
    const context = await consentContext(details);
    const skip =
      canSkipConsent(
        {
          clientId: context.clientId,
          redirectUri: context.redirectUri,
          registeredRedirectUris: context.redirectUris,
        },
        deps.trustedClients,
      ) || (await deps.consentMemory.get(context.memoryKey)) === true;
    if (skip) {
      const tokens = upstreamTokens.take(context.pendingKey);
      if (!tokens) return deny(req, res, 'The Zendesk sign-in expired. Try again.');
      return approve(req, res, details, context, tokens);
    }
    const missing = details.prompt.details as { missingResourceScopes?: Record<string, string[]> };
    const scopes = [...new Set(Object.values(missing.missingResourceScopes ?? {}).flat())];
    sendHtml(
      res,
      200,
      renderConsentPage({
        uid,
        clientName: context.client?.clientName,
        clientId: context.clientId,
        redirectUri: context.redirectUri,
        scopes,
        subdomain: upstream.subdomain,
      }),
    );
  };

  const completeUpstreamLogin = async (
    req: IncomingMessage,
    res: ServerResponse,
    uid: string,
    url: URL,
  ) => {
    const details = await provider.interactionDetails(req, res);
    const verifier = verifiers.take(uid);
    const code = url.searchParams.get('code');
    if (!verifier || !code) {
      return deny(req, res, 'The Zendesk sign-in was cancelled or refused.');
    }
    try {
      const tokens = await exchangeZendeskCode(
        upstream,
        { code, redirectUri: callbackUrl, codeVerifier: verifier },
        logger,
      );
      const identity = await fetchZendeskIdentity(upstream, tokens.accessToken);
      const accountId = `zendesk:${identity.id}`;
      upstreamTokens.set(
        `${accountId}|${String(details.params['client_id'])}`,
        tokens,
        PENDING_TTL_MS,
      );
      await finish(req, res, { login: { accountId } });
    } catch (err) {
      if (!isUpstreamAuthError(err)) throw err;
      logger.warn('oauth_upstream_login_failed', { error: err.message });
      await deny(req, res, err.message);
    }
  };

  const confirm = async (req: IncomingMessage, res: ServerResponse) => {
    const details = await provider.interactionDetails(req, res);
    if (details.prompt.name !== 'consent')
      return sendHtml(res, 400, renderErrorPage('Sign-in failed', EXPIRED));
    const context = await consentContext(details);
    const tokens = upstreamTokens.take(context.pendingKey);
    if (!tokens) return deny(req, res, 'The Zendesk sign-in expired. Try again.');
    await deps.consentMemory.set(context.memoryKey, true, CONSENT_MEMORY_TTL_S);
    return approve(req, res, details, context, tokens);
  };

  const routes = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const segments = url.pathname.split('/');
    // Stryker disable next-line StringLiteral: any default the UID pattern rejects gets the same 404.
    const [, , uid = '', action] = segments;
    if (!UID.test(uid)) return sendHtml(res, 404, renderErrorPage('Not found', EXPIRED));
    if (req.method === 'GET' && action === undefined) return showInteraction(req, res, uid);
    if (req.method === 'GET' && action === 'callback')
      return completeUpstreamLogin(req, res, uid, url);
    if (req.method === 'POST' && action === 'confirm') return confirm(req, res);
    if (req.method === 'POST' && action === 'abort') {
      await provider.interactionDetails(req, res);
      return deny(req, res, 'The user declined access.');
    }
    return sendHtml(res, 404, renderErrorPage('Not found', EXPIRED));
  };

  return {
    /** `/oauth/callback`: the one redirect URI registered at Zendesk. */
    upstreamCallback: (res: ServerResponse, url: URL): void => {
      const state = url.searchParams.get('state');
      // Stryker disable next-line StringLiteral: any default the UID pattern rejects gets the same 400.
      const uid = state ?? '';
      if (!UID.test(uid)) {
        sendHtml(res, 400, renderErrorPage('Sign-in failed', EXPIRED));
        return;
      }
      // The interaction cookie is scoped to /interaction/<uid>, so hop there.
      const next = new URL(`/interaction/${uid}/callback`, issuer);
      const code = url.searchParams.get('code');
      if (code) next.searchParams.set('code', code);
      redirect(res, `${next.pathname}${next.search}`);
    },
    /** `/interaction/<uid>[/callback|/confirm|/abort]`. */
    handle: async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
      try {
        await routes(req, res, url);
      } catch (err) {
        if (!isExpiredLink(err)) throw err;
        if (!res.headersSent) sendHtml(res, 400, renderErrorPage('Sign-in failed', EXPIRED));
      }
    },
  };
};
