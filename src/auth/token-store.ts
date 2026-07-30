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

// Period of the background refresh. Zendesk expires access tokens after ~8h of
// inactivity (and ~12h absolute), so refreshing every 4h keeps a long-lived,
// possibly idle stdio session's token alive with comfortable margin.
const SCHEDULED_REFRESH_MS = 4 * 60 * 60 * 1000;

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
  // Whether we've already probe-refreshed a token with *unknown* expiry. Stays
  // false only for the disk-loaded token at startup so it's refreshed once, then
  // trusted — see `needsRefresh`.
  let probedUnknownExpiry = false;

  const persist = (t: StoredToken): void => saveToken(tokenPath, t, logger);

  const setToken = (accessToken: string, refreshToken?: string | undefined) => {
    token = { accessToken, refreshToken };
    // A token installed this way has no known expiry and unknown age, like the
    // disk-loaded one: let it be probe-refreshed once rather than inheriting a
    // previous token's "already probed" state (the flag is store-wide).
    probedUnknownExpiry = false;
    persist(token);
  };

  // Whether the cached token must be refreshed before use. A known `expiresAt`
  // uses the skew window; an *unknown* expiry (token minted before Zendesk
  // enabled expiration, or a refresh response without `expires_in`) is probed
  // once — refreshed on first use if it has a refresh token, then trusted so we
  // don't refresh on every call when `expires_in` keeps being omitted.
  const needsRefresh = (t: StoredToken): boolean =>
    typeof t.expiresAt === 'number'
      ? Date.now() >= t.expiresAt - EXPIRY_SKEW_MS
      : t.refreshToken !== undefined && !probedUnknownExpiry;

  // Try to silently mint a fresh access token from the stored refresh token.
  // Resolves to the new access token, or `undefined` if there's nothing to
  // refresh / the refresh failed. On failure the on-demand path drops the dead
  // token (so getToken falls back to the browser flow); the background keepalive
  // passes `dropOnFailure: false` because it refreshes preemptively while the
  // access token may still be valid — a transient 5xx/network blip must not wipe
  // a usable token and force needless re-auth.
  const tryRefresh = async (
    current: StoredToken,
    { dropOnFailure = true }: { dropOnFailure?: boolean } = {},
  ): Promise<string | undefined> => {
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
      // Freshly refreshed: if expiry is still unknown, don't re-probe every call.
      probedUnknownExpiry = true;
      persist(token);
      logger.info('oauth_token_refreshed_cached');
      return token.accessToken;
    } catch (err) {
      logger.warn('oauth_token_refresh_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Refresh token expired/invalid → drop it so we fall back to a fresh flow.
      // Skipped for the background keepalive, which must keep a still-valid token
      // alive across a transient failure.
      if (dropOnFailure) {
        token = undefined;
        clearPersistedToken(tokenPath, logger);
      }
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
            // Freshly minted: trust it without an immediate probe-refresh.
            probedUnknownExpiry = true;
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

  // Silent refresh when a refresh token is available. Concurrent callers share
  // the one in-flight attempt: Zendesk rotates the refresh token on every use,
  // so two competing refreshes would invalidate each other. Returns undefined
  // when there is nothing to refresh with, or when the refresh failed.
  const refreshIfPossible = async (): Promise<string | undefined> => {
    const current = token;
    if (!current?.refreshToken) return undefined;
    if (refreshing === undefined) {
      refreshing = tryRefresh(current).finally(() => {
        refreshing = undefined;
      });
    }
    return refreshing;
  };

  const getToken = async (): Promise<string> => {
    // A refresh already in flight (on-demand or the scheduled background one)
    // owns the next token: wait for it instead of serving a token that's about
    // to be replaced or launching a competing refresh. Zendesk rotates the
    // refresh token on every use, so two concurrent refreshes would invalidate
    // each other — this makes the refresh exclusive.
    // `!== undefined`, not truthiness: `refreshing` is a Promise handle used as
    // a presence flag, and a bare `if (refreshing)` reads as if the promise's
    // resolved value were being tested.
    if (refreshing !== undefined) await refreshing;

    if (token && !needsRefresh(token)) {
      logger.debug('oauth_token_cache_hit');
      return token.accessToken;
    }

    // Expired, near-expiry, or unknown-expiry but refreshable → refresh silently
    // before falling back to a browser prompt.
    const refreshed = await refreshIfPossible();
    if (refreshed) return refreshed;

    if (starting === undefined) {
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

  // Background refresh keeps a long-lived, possibly idle stdio session's token
  // fresh: refreshing every 4h means the first request after a quiet stretch
  // never races a token expired by Zendesk's ~8h inactivity window. Shares the
  // `refreshing` single-flight guard with getToken; a no-op until a refreshable
  // token exists. unref()'d so it never keeps the process (or test runner) alive.
  // stdio-only: HTTP carries a per-session bearer and doesn't use this store.
  const scheduledRefresh = setInterval(() => {
    if (token?.refreshToken && !refreshing) {
      refreshing = tryRefresh(token, { dropOnFailure: false }).finally(() => {
        refreshing = undefined;
      });
    }
  }, SCHEDULED_REFRESH_MS);
  scheduledRefresh.unref?.();

  // Stop the background timer (e.g. on shutdown or in tests). Optional for stdio,
  // where the process exit reclaims the unref'd timer anyway.
  const dispose = (): void => clearInterval(scheduledRefresh);

  return { getToken, setToken, invalidate, dispose };
};
