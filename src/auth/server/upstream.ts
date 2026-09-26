import { zendeskGet } from '../../client/zendesk-api';
import { getOAuthUrls } from '../../constants';
import { type Logger, silentLogger } from '../../utils/logger';
import type { TokenResult } from '../browser-oauth';

/**
 * Zendesk as the upstream identity provider, through the same public PKCE client
 * the stdio flow uses. The server runs PKCE itself; no client secret exists.
 * Why: `docs/decisions/oauth-authorization-server.md` ("Upstream login").
 */

// Zendesk's caps: an access token lives 5 min to 48 h, a refresh token 7 to 90
// days. Both are asked for at their maximum so a user signs in again no more
// often than Zendesk itself forces (ADR, constraint 4).
export const ZENDESK_ACCESS_TOKEN_TTL_S = 48 * 3600;
export const ZENDESK_REFRESH_TOKEN_TTL_S = 90 * 86400;

export interface ZendeskUpstream {
  readonly subdomain: string;
  readonly clientId: string;
}

export interface ZendeskTokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  /** Epoch ms; absent when Zendesk reports no expiry. */
  readonly expiresAt?: number | undefined;
  readonly scope?: string | undefined;
}

export interface ZendeskIdentity {
  readonly id: number;
  readonly name?: string | undefined;
  readonly role?: string | undefined;
}

export type UpstreamAuthError = Error & {
  readonly name: 'UpstreamAuthError';
  readonly status?: number;
};

/** ASCII-only (auth paths end up in headers); never carries the Zendesk body. */
const upstreamAuthError = (message: string, status?: number, cause?: unknown): UpstreamAuthError =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    name: 'UpstreamAuthError' as const,
    ...(status === undefined ? {} : { status }),
  });

export const isUpstreamAuthError = (err: unknown): err is UpstreamAuthError =>
  err instanceof Error && err.name === 'UpstreamAuthError';

export const buildZendeskAuthorizeUrl = (
  upstream: ZendeskUpstream,
  params: { redirectUri: string; scope: string; state: string; codeChallenge: string },
): string => {
  const url = new URL(getOAuthUrls(upstream.subdomain).authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', upstream.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
};

const toTokenSet = (result: TokenResult, previousRefreshToken?: string): ZendeskTokenSet => ({
  accessToken: result.access_token,
  refreshToken: result.refresh_token ?? previousRefreshToken,
  expiresAt: result.expires_in === undefined ? undefined : Date.now() + result.expires_in * 1000,
  scope: result.scope,
});

// Deliberately not performFetch: a token request is never replayed (a Zendesk
// code or refresh token is single-use), matching the stdio exchange.
const requestTokens = async (
  upstream: ZendeskUpstream,
  grant: Record<string, string>,
  logger: Logger,
): Promise<TokenResult> => {
  const body = new URLSearchParams({
    client_id: upstream.clientId,
    expires_in: String(ZENDESK_ACCESS_TOKEN_TTL_S),
    refresh_token_expires_in: String(ZENDESK_REFRESH_TOKEN_TTL_S),
    ...grant,
  });
  let response: Response;
  try {
    response = await fetch(getOAuthUrls(upstream.subdomain).tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw upstreamAuthError('Zendesk token endpoint unreachable.', undefined, err);
  }
  logger.debug('oauth_upstream_token', { grant: grant['grant_type'], status: response.status });
  if (!response.ok) {
    throw upstreamAuthError(
      `Zendesk refused the ${grant['grant_type']} grant (${response.status}).`,
      response.status,
    );
  }
  return (await response.json()) as TokenResult;
};

export const exchangeZendeskCode = async (
  upstream: ZendeskUpstream,
  params: { code: string; redirectUri: string; codeVerifier: string },
  logger: Logger = silentLogger,
): Promise<ZendeskTokenSet> =>
  toTokenSet(
    await requestTokens(
      upstream,
      {
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier,
      },
      logger,
    ),
  );

/** Zendesk rotates on refresh: the caller must persist the returned set. */
export const refreshZendeskTokens = async (
  upstream: ZendeskUpstream,
  refreshToken: string,
  logger: Logger = silentLogger,
): Promise<ZendeskTokenSet> =>
  toTokenSet(
    await requestTokens(
      upstream,
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      logger,
    ),
    refreshToken,
  );

/** Zendesk is not OIDC: the account is whoever `/users/me` says the token belongs to. */
export const fetchZendeskIdentity = async (
  upstream: ZendeskUpstream,
  accessToken: string,
): Promise<ZendeskIdentity> => {
  const failure = (cause?: unknown) =>
    upstreamAuthError(
      'Could not resolve the Zendesk account of the signed-in user.',
      undefined,
      cause,
    );
  let user: ZendeskIdentity | undefined;
  try {
    ({ user } = await zendeskGet<{ user: ZendeskIdentity }>(
      upstream.subdomain,
      accessToken,
      '/users/me',
    ));
  } catch (err) {
    throw failure(err);
  }
  // An anonymous or malformed answer must never become an account id.
  if (typeof user?.id !== 'number') throw failure();
  return { id: user.id, name: user.name, role: user.role };
};
