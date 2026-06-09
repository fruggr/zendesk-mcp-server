import { type Logger, silentLogger } from '../utils/logger';
import { refreshAccessToken, startBrowserAuth } from './browser-oauth';
import {
  clearToken as clearPersistedToken,
  loadToken,
  type PersistedToken,
  resolveTokenPath,
  saveToken,
} from './token-persistence';

type StoredToken = PersistedToken;

// Refresh slightly before the real expiry so a request never races a token that
// dies in flight.
const EXPIRY_SKEW_MS = 60_000;

/**
 * Signals that interactive sign-in is required. The message is user-facing: MCP
 * surfaces it as the tool-call error text, so it carries the authorize URL and
 * tells the user to authenticate and retry. Kept as an Error factory (not a
 * class) to match the repo's functional style.
 */
export type AuthRequiredError = Error & { readonly authorizeUrl: string };

export const createAuthRequiredError = (authorizeUrl: string): AuthRequiredError =>
  Object.assign(
    new Error(
      'Zendesk authentication required. A browser window should have opened for you to sign in. ' +
        'If it did not, open this URL in your browser, then retry your request:\n' +
        authorizeUrl,
    ),
    { name: 'AuthRequiredError', authorizeUrl } as const,
  );

export const isAuthRequiredError = (err: unknown): err is AuthRequiredError =>
  err instanceof Error &&
  err.name === 'AuthRequiredError' &&
  typeof (err as AuthRequiredError).authorizeUrl === 'string';

// Compute the absolute expiry (epoch ms) from an OAuth `expires_in` (seconds),
// or `undefined` for a non-expiring token.
const expiryFrom = (expiresIn: number | undefined): number | undefined =>
  typeof expiresIn === 'number' ? Date.now() + expiresIn * 1000 : undefined;

export const createTokenStore = (
  config: { subdomain: string; oauthClientId: string; callbackPort?: number | undefined },
  logger: Logger = silentLogger,
) => {
  const tokenPath = resolveTokenPath(config.subdomain);
  // Seed the in-memory cache from disk so a restart (notably the Cowork-on-Windows
  // process churn) reuses the existing token instead of re-prompting.
  let token: StoredToken | undefined = loadToken(tokenPath);
  if (token) logger.debug('oauth_token_loaded_from_disk');

  // The authorize URL of the in-flight flow (set once the callback server is
  // listening); `undefined` means no flow is currently pending.
  let authorizeUrl: string | undefined;
  // Resolves to the authorize URL while a flow is being started; guards against
  // launching multiple browser flows for concurrent first calls.
  let starting: Promise<string> | undefined;
  // De-dupes concurrent refresh attempts so a burst of expired-token calls
  // triggers a single network round-trip.
  let refreshing: Promise<string | undefined> | undefined;

  const persist = (t: StoredToken): void => saveToken(tokenPath, t, logger);

  const setToken = (accessToken: string, refreshToken?: string | undefined) => {
    token = { accessToken, refreshToken };
    persist(token);
  };

  const isExpired = (t: StoredToken): boolean =>
    typeof t.expiresAt === 'number' && Date.now() >= t.expiresAt - EXPIRY_SKEW_MS;

  // Try to silently mint a fresh access token from the stored refresh token.
  // Resolves to the new access token, or `undefined` if there's nothing to
  // refresh / the refresh failed (in which case the dead token is dropped).
  const tryRefresh = async (current: StoredToken): Promise<string | undefined> => {
    if (!current.refreshToken) return undefined;
    try {
      const result = await refreshAccessToken(
        {
          subdomain: config.subdomain,
          oauthClientId: config.oauthClientId,
          refreshToken: current.refreshToken,
        },
        logger,
      );
      // Zendesk rotates the refresh token on every use — persist the new one (or
      // keep the current one if the response omitted it).
      token = {
        accessToken: result.access_token,
        refreshToken: result.refresh_token ?? current.refreshToken,
        expiresAt: expiryFrom(result.expires_in),
      };
      persist(token);
      logger.info('oauth_token_refreshed_cached');
      return token.accessToken;
    } catch (err) {
      logger.warn('oauth_token_refresh_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Refresh token expired/invalid → drop it so we fall back to a fresh flow.
      token = undefined;
      clearPersistedToken(tokenPath, logger);
      return undefined;
    }
  };

  const beginAuth = (): Promise<string> => {
    logger.info('oauth_auth_start');
    return startBrowserAuth(
      {
        subdomain: config.subdomain,
        oauthClientId: config.oauthClientId,
        callbackPort: config.callbackPort,
      },
      logger,
    )
      .then((started) => {
        authorizeUrl = started.authorizeUrl;
        started.tokenPromise
          .then((result) => {
            token = {
              accessToken: result.access_token,
              refreshToken: result.refresh_token,
              expiresAt: expiryFrom(result.expires_in),
            };
            persist(token);
            logger.info('oauth_token_cached');
          })
          .catch((err) => {
            logger.warn('oauth_auth_failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            // Let the next call start a fresh flow: on success the cached token
            // short-circuits anyway; on failure/timeout we want a clean retry.
            starting = undefined;
            authorizeUrl = undefined;
          });
        return started.authorizeUrl;
      })
      .catch((err) => {
        // The callback server couldn't even start listening (e.g. port in use).
        // Reset so a later call can retry, and surface the underlying error.
        starting = undefined;
        throw err;
      });
  };

  const getToken = async (): Promise<string> => {
    if (token && !isExpired(token)) {
      logger.debug('oauth_token_cache_hit');
      return token.accessToken;
    }

    // Expired (or near-expiry) but refreshable → refresh silently before falling
    // back to a browser prompt. Concurrent callers share the one attempt.
    if (token?.refreshToken) {
      if (!refreshing) {
        refreshing = tryRefresh(token).finally(() => {
          refreshing = undefined;
        });
      }
      const refreshed = await refreshing;
      if (refreshed) return refreshed;
    }

    if (!starting) {
      starting = beginAuth();
    }

    // Fail fast: don't hold the tool call open for the whole browser flow.
    // Surface the authorize URL so the user can sign in, then retry — the
    // callback server keeps running in the background and caches the token,
    // so the next call succeeds.
    const url = authorizeUrl ?? (await starting);
    throw createAuthRequiredError(url);
  };

  // Backstop for an access token the server rejected mid-life (e.g. revoked).
  // A 401 invalidates the *access* token, not necessarily the refresh token —
  // so keep the latter and just mark the access token expired, letting the next
  // getToken attempt a silent refresh before falling back to the browser. Only
  // when there's no refresh token do we wipe the record entirely.
  const invalidate = (): void => {
    if (token?.refreshToken) {
      token = { accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: 0 };
      persist(token);
    } else {
      token = undefined;
      clearPersistedToken(tokenPath, logger);
    }
    logger.info('oauth_token_invalidated');
  };

  return { getToken, setToken, invalidate };
};
