import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { release } from 'node:os';
import open from 'open';
import { DEFAULT_CALLBACK_PORT, getOAuthUrls } from '../constants';
import { type Logger, silentLogger } from '../utils/logger';

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
  // Present only when the Zendesk OAuth client has token expiration enabled.
  // Seconds until the access/refresh token expires.
  expires_in?: number;
  refresh_token_expires_in?: number;
}

/**
 * Build an actionable error for a callback port that's already taken. The raw
 * Node `EADDRINUSE` is opaque to both the user and the LLM; this spells out the
 * fix (set a free port + register the matching redirect URL in Zendesk). The
 * `(EADDRINUSE)` marker and `code` are kept for diagnostics/tests.
 */
const callbackPortInUseError = (port: number, cause: Error): Error =>
  Object.assign(
    new Error(
      `Cannot start the Zendesk OAuth sign-in: local callback port ${port} is already in use ` +
        `by another process. Set ZENDESK_OAUTH_CALLBACK_PORT (or --callback-port) to a free port, ` +
        `then register http://localhost:<port>/callback as a redirect URL in your Zendesk OAuth ` +
        `client. (EADDRINUSE)`,
    ),
    { code: 'EADDRINUSE', cause },
  );

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

// Pages served back to the browser tab that completed (or failed) the flow.
// ASCII only, like every other string on the auth path.
const errorPage = (title: string, detail?: string): string =>
  `<html><body><h1>${escapeHtml(title)}</h1>${detail === undefined ? '' : `<p>${escapeHtml(detail)}</p>`}</body></html>`;

const SUCCESS_PAGE =
  '<html><body>' +
  '<h1>Authentication successful!</h1>' +
  '<p>You can close this tab and return to your AI assistant.</p>' +
  '<p>This tab will auto-close in <span id="t">10</span>s.</p>' +
  '<script>' +
  'let n=10;' +
  'const el=document.getElementById("t");' +
  'const i=setInterval(()=>{n--;el.textContent=n;if(n<=0){clearInterval(i);window.close();}},1000);' +
  '</script>' +
  '</body></html>';

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

// How a completed callback settles the token promise, carried as data so the
// request handler does not need a callback per branch.
type CallbackOutcome = { ok: true; token: TokenResult } | { ok: false; error: unknown };

interface CallbackResolution {
  status: number;
  html: string;
  outcome: CallbackOutcome;
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

    // PKCE code -> token. The redirect_uri must be byte-identical to the one
    // sent on the authorize call, so it is rebuilt from the port actually bound
    // rather than the requested one.
    const exchangeCodeForToken = async (code: string): Promise<TokenResult> => {
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
      return (await tokenResponse.json()) as TokenResult;
    };

    // Every terminal path of the callback does the same three things: answer the
    // browser tab, stop the timeout and the callback server, then settle the
    // token promise. Taking the outcome as data rather than a callback keeps the
    // request handler free of nested closures.
    const finishRequest = (
      res: ServerResponse,
      { status, html, outcome }: CallbackResolution,
    ): void => {
      res.writeHead(status, { 'Content-Type': 'text/html' });
      res.end(html);
      clearTimeout(authTimeout);
      callbackServer.close();
      if (outcome.ok) resolveToken(outcome.token);
      else rejectToken(outcome.error);
    };

    // Decide what the callback means: an OAuth error, a missing code, or a code
    // to exchange. Returns the page to serve and how the token promise should
    // settle, so the request handler stays pure plumbing.
    const resolveCallback = async (url: URL): Promise<CallbackResolution> => {
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      logger.debug('oauth_callback_received', {
        hasCode: Boolean(code),
        hasError: Boolean(error),
      });

      if (error) {
        const desc = url.searchParams.get('error_description') ?? error;
        return {
          status: 400,
          html: errorPage('Authentication failed', desc),
          outcome: { ok: false, error: new Error(`OAuth error: ${desc}`) },
        };
      }

      if (!code) {
        return {
          status: 400,
          html: errorPage('Missing authorization code'),
          outcome: { ok: false, error: new Error('Missing authorization code in callback') },
        };
      }

      try {
        const token = await exchangeCodeForToken(code);
        logger.info('oauth_authenticated');
        return { status: 200, html: SUCCESS_PAGE, outcome: { ok: true, token } };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          status: 500,
          html: errorPage('Token exchange failed', detail),
          outcome: { ok: false, error: err },
        };
      }
    };

    callbackServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      finishRequest(res, await resolveCallback(url));
    });

    const requestedPort = config.callbackPort ?? DEFAULT_CALLBACK_PORT;

    // Listen failure (e.g. port already in use) before we ever get a URL: the
    // whole start fails so the caller can surface/retry. EADDRINUSE is rewrapped
    // into an actionable message (user *and* LLM can act on it).
    // No `clearTimeout` here on purpose: `authTimeout` is only assigned inside the
    // `listen` callback, which also `off`s this handler first — so whenever this
    // runs the timeout is still `undefined` and clearing it was a no-op.
    const onStartError = (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;
      logger.error('oauth_callback_listen_failed', { port: requestedPort, errorCode: code });
      rejectStarted(code === 'EADDRINUSE' ? callbackPortInUseError(requestedPort, err) : err);
    };
    callbackServer.once('error', onStartError);

    // Start on fixed port (must match redirect_uri registered in Zendesk OAuth client)
    callbackServer.listen(requestedPort, () => {
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
      // Stryker disable next-line CallExpression: dropping `unref()` only changes
      // whether a pending 5-minute timer holds the event loop open, which a test
      // process (kept alive by the runner) cannot observe. Load-bearing in
      // production: without it a finished CLI run would linger until the timeout.
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

/**
 * Exchange a refresh token for a fresh access token (and a rotated refresh token)
 * without any browser interaction. Public PKCE clients send no `client_secret`.
 * Zendesk refresh tokens are single-use: the caller MUST persist the new
 * `refresh_token` from the response. Throws on a non-2xx (expired/invalid
 * refresh token) so the caller can fall back to the full browser flow.
 */
export const refreshAccessToken = async (
  config: { subdomain: string; oauthClientId: string; refreshToken: string },
  logger: Logger = silentLogger,
): Promise<TokenResult> => {
  const { tokenUrl } = getOAuthUrls(config.subdomain);

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: config.refreshToken,
    client_id: config.oauthClientId,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  logger.debug('oauth_token_refresh', { status: response.status });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${errorBody}`);
  }

  const tokenData = (await response.json()) as TokenResult;
  logger.info('oauth_token_refreshed');
  return tokenData;
};
