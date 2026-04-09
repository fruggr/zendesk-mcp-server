import { createServer, type Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { getOAuthUrls } from '../constants';

const DEFAULT_CALLBACK_PORT = 3000;

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

const openBrowser = async (url: string): Promise<void> => {
  // Dynamic import to handle different platforms
  const { platform } = await import('node:os');
  const { exec } = await import('node:child_process');
  const os = platform();

  const command =
    os === 'darwin' ? 'open'
    : os === 'win32' ? 'start'
    : 'xdg-open';

  exec(`${command} "${url}"`);
};

/**
 * Performs OAuth 2.1 PKCE flow by opening the user's browser.
 * Starts a temporary HTTP server to receive the callback.
 * Returns the access token on success.
 */
export const authenticateViaBrowser = (config: BrowserOAuthConfig): Promise<TokenResult> => {
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

        if (!tokenResponse.ok) {
          const errorBody = await tokenResponse.text();
          throw new Error(`Token exchange failed (${tokenResponse.status}): ${errorBody}`);
        }

        const tokenData = (await tokenResponse.json()) as TokenResult;

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
        res.end(`<html><body><h1>Token exchange failed</h1><p>${err instanceof Error ? err.message : String(err)}</p></body></html>`);
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
      console.error(`Opening browser for Zendesk authentication...`);
      console.error(`If the browser doesn't open, visit: ${authUrl}`);

      openBrowser(authUrl).catch(() => {
        // Browser open failed — the URL is already logged
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      callbackServer.close();
      reject(new Error('OAuth authentication timed out (5 min). Please try again.'));
    }, 5 * 60 * 1000).unref();
  });
};
