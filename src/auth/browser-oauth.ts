import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { release } from 'node:os';
import open from 'open';
import { getOAuthUrls } from '../constants';
import { type Logger, silentLogger } from '../utils/logger';

const DEFAULT_CALLBACK_PORT = 3000;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

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

/**
 * Escape a string for safe interpolation into HTML text/attribute context.
 * The local callback server echoes attacker-controllable values (the OAuth
 * `error_description` query param, token-exchange error bodies) back into the
 * browser response; without escaping these are a reflected-XSS sink.
 */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * A started OAuth flow: the local callback server is already listening and the
 * browser-open attempt has been made. `authorizeUrl` is available immediately
 * (so callers can surface it to the user without blocking), while `tokenPromise`
 * resolves later, when the user completes the browser flow — or rejects on
 * error/timeout.
 */
export interface StartedBrowserAuth {
  authorizeUrl: string;
  tokenPromise: Promise<TokenResult>;
}

const generateCodeVerifier = (): string => randomBytes(32).toString('base64url');

const generateCodeChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

/**
 * Begin the OAuth 2.1 PKCE flow: start the local callback server, attempt to
 * open the browser, and return as soon as the server is listening with the
 * authorize URL plus a promise that settles when the callback arrives.
 *
 * Splitting "start" from "await the token" lets callers stay non-blocking: they
 * can hand the URL back to the user immediately instead of holding a request
 * open for up to the 5-minute timeout.
 */
export const startBrowserAuth = (
  config: BrowserOAuthConfig,
  logger: Logger = silentLogger,
): Promise<StartedBrowserAuth> => {
  const { subdomain, oauthClientId } = config;
  const { authorizeUrl: authorizeBase, tokenUrl } = getOAuthUrls(subdomain);
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  return new Promise<StartedBrowserAuth>((resolveStarted, rejectStarted) => {
    let resolveToken!: (token: TokenResult) => void;
    let rejectToken!: (err: unknown) => void;
    const tokenPromise = new Promise<TokenResult>((resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    });

    let authTimeout: ReturnType<typeof setTimeout> | undefined;
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
        res.end(
          `<html><body><h1>Authentication failed</h1><p>${escapeHtml(desc)}</p></body></html>`,
        );
        clearTimeout(authTimeout);
        callbackServer.close();
        rejectToken(new Error(`OAuth error: ${desc}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Missing authorization code</h1></body></html>');
        clearTimeout(authTimeout);
        callbackServer.close();
        rejectToken(new Error('Missing authorization code in callback'));
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
          '<html><body>' +
            '<h1>Authentication successful!</h1>' +
            '<p>You can close this tab and return to Claude Code.</p>' +
            '<p>This tab will auto-close in <span id="t">10</span>s.</p>' +
            '<script>' +
            'let n=10;' +
            'const el=document.getElementById("t");' +
            'const i=setInterval(()=>{n--;el.textContent=n;if(n<=0){clearInterval(i);window.close();}},1000);' +
            '</script>' +
            '</body></html>',
        );

        clearTimeout(authTimeout);
        callbackServer.close();
        resolveToken(tokenData);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(
          `<html><body><h1>Token exchange failed</h1><p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p></body></html>`,
        );
        clearTimeout(authTimeout);
        callbackServer.close();
        rejectToken(err);
      }
    });

    // Listen failure (e.g. port already in use) before we ever get a URL: the
    // whole start fails so the caller can surface/retry.
    const onStartError = (err: Error) => {
      clearTimeout(authTimeout);
      rejectStarted(err);
    };
    callbackServer.once('error', onStartError);

    // Start on fixed port (must match redirect_uri registered in Zendesk OAuth client)
    callbackServer.listen(config.callbackPort ?? DEFAULT_CALLBACK_PORT, () => {
      // Now that we're listening, a later server error must settle the *token*
      // flow (the started promise is already resolved) and tear the server down,
      // so the token store doesn't wedge waiting on a promise that never settles.
      callbackServer.off('error', onStartError);
      callbackServer.once('error', (err) => {
        clearTimeout(authTimeout);
        callbackServer.close();
        rejectToken(err);
      });

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

      const authUrl = `${authorizeBase}?${params.toString()}`;
      logger.debug('oauth_callback_listening', { port, redirectUri });
      logger.info('oauth_browser_opening');
      // Full authorize URL is debug-only: it carries the (public) client_id and
      // PKCE challenge — no secret — but stays out of default-level logs.
      logger.debug('oauth_authorize_url', { url: authUrl });
      // Always-on, ungated user-facing fallback: if the browser can't open, the
      // user must see this URL regardless of LOG_LEVEL — do NOT route it through
      // the (level-gated) logger.
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

      // Timeout after 5 minutes. Cleared on every completion path above so a
      // successful auth can't emit a spurious `oauth_timeout` error later.
      authTimeout = setTimeout(() => {
        logger.error('oauth_timeout', { timeoutMs: AUTH_TIMEOUT_MS });
        callbackServer.close();
        rejectToken(new Error('OAuth authentication timed out (5 min). Please try again.'));
      }, AUTH_TIMEOUT_MS);
      authTimeout.unref();

      resolveStarted({ authorizeUrl: authUrl, tokenPromise });
    });
  });
};

/**
 * Convenience wrapper that performs the full PKCE flow and resolves with the
 * token once the browser flow completes (blocking until then). Retained for
 * callers/tests that want the original "await the token" semantics.
 */
export const authenticateViaBrowser = async (
  config: BrowserOAuthConfig,
  logger: Logger = silentLogger,
): Promise<TokenResult> => {
  const { tokenPromise } = await startBrowserAuth(config, logger);
  return tokenPromise;
};
