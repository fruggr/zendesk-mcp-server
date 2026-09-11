import { type Logger, silentLogger } from '../utils/logger';
import { refreshAccessToken, startBrowserAuth } from './browser-oauth';
import { grantCovers, requestedScope } from './oauth-scopes';
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
  config: {
    subdomain: string;
    oauthClientId: string;
    callbackPort?: number | undefined;
    readOnly: boolean;
  },
  logger: Logger = silentLogger,
) => {
  const tokenPath = resolveTokenPath(config.subdomain);
  // Fixed for the life of the process: the tool surface cannot change under us.
  const requested = requestedScope(config.readOnly);
  // Seed the in-memory cache from disk so a restart (notably the Cowork-on-Windows
  // process churn) reuses the existing token instead of re-prompting.
  let token: StoredToken | undefined = loadToken(tokenPath);
  if (token) {
    if (grantCovers(token.scope, requested)) {
      logger.debug('oauth_token_loaded_from_disk');
    } else {
      // Minted for a narrower surface (this server dropped `--read-only`
      // since), and a refresh cannot widen a grant, so the empty cache sends
      // the first call through a sign-in. Checked here only: a minted token is
      // the best we can get. Memory-only -- a sibling may still need the record.
      logger.warn('oauth_token_scope_insufficient', { requested, granted: token.scope });
      token = undefined;
    }
  }

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
    // Recorded like any other installation path: an absent scope means "the
    // read write grant this server used to be the only one to request", which
    // is not what a token installed under `--read-only` holds.
    token = { accessToken, refreshToken, scope: requested };
    // A token installed this way has no known expiry and unknown age, like the
    // disk-loaded one: let it be probe-refreshed once rather than inheriting a
    // previous token's "already probed" state (the flag is store-wide).
    probedUnknownExpiry = false;
    persist(token);
  };

  // A known `expiresAt` uses the skew window; an *unknown* expiry (token minted
  // before Zendesk enabled expiration, or a refresh response without
  // `expires_in`) is probed once, then trusted — otherwise an omitted
  // `expires_in` would have us refresh on every call.
  const needsRefresh = (t: StoredToken): boolean =>
    typeof t.expiresAt === 'number'
      ? Date.now() >= t.expiresAt - EXPIRY_SKEW_MS
      : t.refreshToken !== undefined && !probedUnknownExpiry;

  // Records a grant, warning when it falls short of what this process asked for.
  // The token is still served: a new authorization would return the same narrow
  // grant, so refusing it would re-prompt forever. Zendesk rejects an
  // out-of-allowance scope outright, so this guards an RFC-legal downgrade.
  const noteGrant = (granted: string | undefined): string | undefined => {
    if (!grantCovers(granted, requested)) {
      logger.warn('oauth_token_grant_narrowed', { requested, granted });
    }
    return granted;
  };

  // Silently mints an access token from the stored refresh token. On failure the
  // on-demand path drops the dead token, so getToken falls back to the browser;
  // the keepalive passes `dropOnFailure: false`, as it refreshes while the token
  // may still be valid, and a blip must not wipe a usable one.
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
        // Same rule as the refresh token above: an omitted `scope` means the
        // grant is unchanged, not unknown. `||`, not `??`: an empty string is
        // "not reported" too, and must not be recorded as a grant of nothing.
        scope: noteGrant(result.scope || current.scope),
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
        readOnly: config.readOnly,
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
              scope: noteGrant(result.scope || requested),
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
    // A refresh already in flight owns the next token: wait for it rather than
    // serve a token about to be replaced, or launch a competing refresh. Zendesk
    // rotates the refresh token on every use, so two concurrent refreshes would
    // invalidate each other.
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

  // Backstop for an access token the server rejected mid-life (revoked, say). A
  // 401 invalidates the *access* token, not necessarily the refresh token — keep
  // the latter and mark the access token expired, so the next getToken tries a
  // silent refresh before the browser.
  const invalidate = (): void => {
    if (token?.refreshToken) {
      token = {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: 0,
        scope: token.scope,
      };
      persist(token);
    } else {
      token = undefined;
      clearPersistedToken(tokenPath, logger);
    }
    logger.info('oauth_token_invalidated');
  };

  // Keeps a long-lived, possibly idle stdio session's token fresh: every 4h means
  // the first request after a quiet stretch never races Zendesk's ~8h inactivity
  // window. unref()'d so it never keeps the process (or test runner) alive.
  // stdio-only: HTTP carries a per-session bearer.
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
