import { type Logger, silentLogger } from '../utils/logger';
import { startBrowserAuth } from './browser-oauth';

interface StoredToken {
  accessToken: string;
  refreshToken?: string | undefined;
}

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

export const createTokenStore = (
  config: { subdomain: string; oauthClientId: string },
  logger: Logger = silentLogger,
) => {
  let token: StoredToken | undefined;
  // The authorize URL of the in-flight flow (set once the callback server is
  // listening); `undefined` means no flow is currently pending.
  let authorizeUrl: string | undefined;
  // Resolves to the authorize URL while a flow is being started; guards against
  // launching multiple browser flows for concurrent first calls.
  let starting: Promise<string> | undefined;

  const setToken = (accessToken: string, refreshToken?: string | undefined) => {
    token = { accessToken, refreshToken };
  };

  const beginAuth = (): Promise<string> => {
    logger.info('oauth_auth_start');
    return startBrowserAuth(
      { subdomain: config.subdomain, oauthClientId: config.oauthClientId },
      logger,
    )
      .then((started) => {
        authorizeUrl = started.authorizeUrl;
        started.tokenPromise
          .then((result) => {
            token = { accessToken: result.access_token, refreshToken: result.refresh_token };
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
    if (token) {
      logger.debug('oauth_token_cache_hit');
      return token.accessToken;
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

  return { getToken, setToken };
};
