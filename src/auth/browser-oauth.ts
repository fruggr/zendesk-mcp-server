import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { release } from 'node:os';
import open from 'open';
import { getOAuthUrls } from '../constants';
import { type Logger, silentLogger } from '../utils/logger';

const DEFAULT_CALLBACK_PORT = 3000;

/** Best-effort WSL detection: WSL kernels carry "microsoft" in /proc/version. */
const detectWsl = (): boolean => {
  if (process.platform !== 'linux') return false;
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
};

interface BrowserOAuthConfig {
  subdomain: string;
  oauthClientId: string;
  callbackPort?: number | undefined;
}

interface TokenResult {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope: string;
}

const generateCodeVerifier = (): string => randomBytes(32).toString('base64url');

const generateCodeChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

/**
 * Performs OAuth 2.1 PKCE flow by opening the user's browser.
 * Starts a temporary HTTP server to receive the callback.
 * Returns the access token on success.
 */
export const authenticateViaBrowser = (
  config: BrowserOAuthConfig,
  logger: Logger = silentLogger,
): Promise<TokenResult> => {
  const { subdomain, oauthClientId } = config;
  const { authorizeUrl, tokenUrl } = getOAuthUrls(subdomain);
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  return new Promise((resolve, reject) => {
    let callbackServer: Server;

    callbackServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      logger.debug('oauth_callback_received', {
        hasCode: Boolean(code),
        hasError: Boolean(error),
      });

      if (error) {
        const desc = url.searchParams.get('error_description') ?? error;
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Authentication failed</h1><p>${desc}</p></body></html>`);
        callbackServer.close();
        reject(new Error(`OAuth error: ${desc}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Missing authorization code</h1></body></html>');
        callbackServer.close();
        reject(new Error('Missing authorization code in callback'));
        return;
      }

      // Exchange code for token
      try {
        const callbackPort = (callbackServer.address() as { port: number }).port;
        const tokenBody = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: oauthClientId,
          redirect_uri: `http://localhost:${callbackPort}/callback`,
          code_verifier: codeVerifier,
        });

        const tokenResponse = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody.toString(),
        });

        logger.debug('oauth_token_exchange', { status: tokenResponse.status });

        if (!tokenResponse.ok) {
          const errorBody = await tokenResponse.text();
          throw new Error(`Token exchange failed (${tokenResponse.status}): ${errorBody}`);
        }

        const tokenData = (await tokenResponse.json()) as TokenResult;
        logger.info('oauth_authenticated');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h1>Authentication successful!</h1>' +
            '<p>You can close this tab and return to Claude Code.</p>' +
            '<script>window.close()</script></body></html>',
        );

        callbackServer.close();
        resolve(tokenData);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(
          `<html><body><h1>Token exchange failed</h1><p>${err instanceof Error ? err.message : String(err)}</p></body></html>`,
        );
        callbackServer.close();
        reject(err);
      }
    });

    // Start on fixed port (must match redirect_uri registered in Zendesk OAuth client)
    callbackServer.listen(config.callbackPort ?? DEFAULT_CALLBACK_PORT, () => {
      const port = (callbackServer.address() as { port: number }).port;
      const redirectUri = `http://localhost:${port}/callback`;

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: oauthClientId,
        redirect_uri: redirectUri,
        scope: 'read write',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      const authUrl = `${authorizeUrl}?${params.toString()}`;
      logger.debug('oauth_callback_listening', { port, redirectUri });
      logger.info('oauth_browser_opening');
      // Full authorize URL is debug-only: it carries the (public) client_id and
      // PKCE challenge — no secret — but stays out of default-level logs.
      logger.debug('oauth_authorize_url', { url: authUrl });
      console.error(`Opening browser for Zendesk authentication...`);
      console.error(`If the browser doesn't open, visit: ${authUrl}`);

      open(authUrl)
        .then(() => {
          logger.debug('oauth_browser_opened');
        })
        .catch((err: unknown) => {
          // Do NOT swallow: this is the #60 signal. Capture why `open` failed
          // plus environment markers (presence only, never values).
          logger.error('oauth_browser_open_failed', {
            error: err instanceof Error ? err.message : String(err),
            errorCode: (err as NodeJS.ErrnoException | undefined)?.code,
            platform: process.platform,
            release: release(),
            isWsl: detectWsl(),
            hasSystemRoot: Boolean(process.env['SYSTEMROOT']),
            hasWindir: Boolean(process.env['WINDIR']),
            hasComSpec: Boolean(process.env['ComSpec']),
            hasPath: Boolean(process.env['PATH']),
            hasDisplay: Boolean(process.env['DISPLAY']),
          });
        });
    });

    // Timeout after 5 minutes
    setTimeout(
      () => {
        logger.error('oauth_timeout', { timeoutMs: 5 * 60 * 1000 });
        callbackServer.close();
        reject(new Error('OAuth authentication timed out (5 min). Please try again.'));
      },
      5 * 60 * 1000,
    ).unref();
  });
};
