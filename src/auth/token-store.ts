import { type Logger, silentLogger } from '../utils/logger';
import { authenticateViaBrowser } from './browser-oauth';

interface StoredToken {
  accessToken: string;
  refreshToken?: string | undefined;
}

export const createTokenStore = (
  config: { subdomain: string; oauthClientId: string },
  logger: Logger = silentLogger,
) => {
  let token: StoredToken | undefined;
  let authPromise: Promise<StoredToken> | undefined;

  const setToken = (accessToken: string, refreshToken?: string | undefined) => {
    token = { accessToken, refreshToken };
  };

  const ensureToken = async (): Promise<StoredToken> => {
    if (token) {
      logger.debug('oauth_token_cache_hit');
      return token;
    }

    if (!authPromise) {
      logger.info('oauth_auth_start');
      authPromise = authenticateViaBrowser(
        {
          subdomain: config.subdomain,
          oauthClientId: config.oauthClientId,
        },
        logger,
      )
        .then((result) => {
          const stored: StoredToken = {
            accessToken: result.access_token,
            refreshToken: result.refresh_token,
          };
          token = stored;
          authPromise = undefined;
          return stored;
        })
        .catch((err) => {
          authPromise = undefined;
          logger.warn('oauth_auth_failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        });
    }

    return authPromise;
  };

  const getToken = async (): Promise<string> => {
    const stored = await ensureToken();
    return stored.accessToken;
  };

  return { getToken, setToken };
};
