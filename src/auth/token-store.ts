import { authenticateViaBrowser } from './browser-oauth';

interface StoredToken {
  accessToken: string;
  refreshToken?: string | undefined;
}

export const createTokenStore = (config: {
  subdomain: string;
  oauthClientId: string;
}) => {
  let token: StoredToken | undefined;
  let authPromise: Promise<StoredToken> | undefined;

  const setToken = (accessToken: string, refreshToken?: string | undefined) => {
    token = { accessToken, refreshToken };
  };

  const ensureToken = async (): Promise<StoredToken> => {
    if (token) return token;

    if (!authPromise) {
      authPromise = authenticateViaBrowser({
        subdomain: config.subdomain,
        oauthClientId: config.oauthClientId,
      }).then((result) => {
        const stored: StoredToken = {
          accessToken: result.access_token,
          refreshToken: result.refresh_token,
        };
        token = stored;
        authPromise = undefined;
        return stored;
      }).catch((err) => {
        authPromise = undefined;
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
