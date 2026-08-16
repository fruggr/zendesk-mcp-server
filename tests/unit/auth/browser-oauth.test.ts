import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oauthTokenHandler } from '../../msw-handlers';
import { mswServer } from '../../setup';

const openMock = vi.fn<(url: string) => Promise<unknown>>();

vi.mock('open', () => ({
  default: (url: string) => openMock(url),
}));

// Every callback server the flow creates, in order. The teardown assertions below
// need the instance itself: `listening` is the only honest way to check the server
// was actually stopped (a closed port is indistinguishable from a slow one over
// loopback), and emitting `error` on it is the only way to reach the post-`listen`
// error handler, which nothing external can provoke. Delegates to the real
// module so MSW's interception and the port-in-use test are untouched.
const callbackServers: Server[] = [];

vi.mock('node:http', async () => {
  const actual = await vi.importActual<typeof import('node:http')>('node:http');
  return {
    ...actual,
    default: actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      callbackServers.push(server);
      return server;
    },
  };
});

/** The server backing the flow that started most recently. */
const lastCallbackServer = (): Server => {
  const server = callbackServers.at(-1);
  if (!server) throw new Error('no callback server was created');
  return server;
};

/** Wait for `server.listening` to go false, so `close()` is observed, not raced. */
const awaitClosed = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.once('close', () => resolve()));
};

// Imported after vi.mock so the mocked `open` is bound.
const { authenticateViaBrowser, refreshAccessToken, startBrowserAuth } = await import(
  '../../../src/auth/browser-oauth'
);

const makeLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  attachServer: vi.fn(),
});

const SUB = 'testsubdomain';
const CLIENT_ID = 'test_client';

describe('authenticateViaBrowser', () => {
  beforeEach(() => {
    openMock.mockReset();
    callbackServers.length = 0;
  });

  it('opens the browser once on the Zendesk authorize URL and completes the PKCE flow', async () => {
    mswServer.use(
      http.post(`https://${SUB}.zendesk.com/oauth/tokens`, async ({ request }) => {
        const body = await request.text();
        const params = new URLSearchParams(body);
        expect(params.get('grant_type')).toBe('authorization_code');
        expect(params.get('code')).toBe('the-auth-code');
        expect(params.get('client_id')).toBe(CLIENT_ID);
        expect(params.get('code_verifier')).toBeTruthy();
        return HttpResponse.json({
          access_token: 'token-abc',
          token_type: 'bearer',
          scope: 'read write',
        });
      }),
    );

    // Capture the authorize URL as soon as `open` is called, then
    // simulate the browser callback hitting our local HTTP server.
    openMock.mockImplementation(async (url: string) => {
      const authUrl = new URL(url);
      const redirectUri = authUrl.searchParams.get('redirect_uri');
      expect(redirectUri).toBeTruthy();
      // Fire the callback (decouple from this microtask so the auth
      // promise can keep awaiting the HTTP server).
      setImmediate(() => {
        fetch(`${redirectUri}?code=the-auth-code`).catch(() => {
          /* server will close as soon as it has processed the code */
        });
      });
      return {};
    });

    const result = await authenticateViaBrowser({
      subdomain: SUB,
      oauthClientId: CLIENT_ID,
      callbackPort: 0,
    });

    expect(result.access_token).toBe('token-abc');
    expect(openMock).toHaveBeenCalledTimes(1);

    const openedUrl = new URL(openMock.mock.calls[0]?.[0] ?? '');
    expect(openedUrl.origin).toBe(`https://${SUB}.zendesk.com`);
    expect(openedUrl.pathname).toBe('/oauth/authorizations/new');
    expect(openedUrl.searchParams.get('response_type')).toBe('code');
    expect(openedUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(openedUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(openedUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(openedUrl.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/localhost:\d+\/callback$/,
    );
  });

  it('the success page tells the user the tab will auto-close', async () => {
    mswServer.use(oauthTokenHandler);

    let resolveBody: (body: string) => void;
    const bodyPromise = new Promise<string>((r) => {
      resolveBody = r;
    });

    openMock.mockImplementation(async (url: string) => {
      const redirectUri = new URL(url).searchParams.get('redirect_uri');
      setImmediate(() => {
        fetch(`${redirectUri}?code=the-auth-code`)
          .then((res) => res.text())
          .then((text) => resolveBody(text))
          .catch(() => resolveBody(''));
      });
      return {};
    });

    await authenticateViaBrowser({ subdomain: SUB, oauthClientId: CLIENT_ID, callbackPort: 0 });

    const body = await bodyPromise;
    expect(body).toContain('Authentication successful!');
    expect(body).toContain('auto-close');
  });

  it('HTML-escapes the OAuth error_description in the callback response (no reflected XSS)', async () => {
    const xss = '<script>alert(1)</script>';
    let resolveBody: (body: string) => void;
    const bodyPromise = new Promise<string>((r) => {
      resolveBody = r;
    });

    openMock.mockImplementation(async (url: string) => {
      const redirectUri = new URL(url).searchParams.get('redirect_uri');
      setImmediate(() => {
        fetch(`${redirectUri}?error=access_denied&error_description=${encodeURIComponent(xss)}`)
          .then((res) => res.text())
          .then((text) => resolveBody(text))
          .catch(() => resolveBody(''));
      });
      return {};
    });

    await expect(
      authenticateViaBrowser({ subdomain: SUB, oauthClientId: CLIENT_ID, callbackPort: 0 }),
    ).rejects.toThrow(/OAuth error/);

    const body = await bodyPromise;
    expect(body).not.toContain(xss);
    expect(body).toContain('&lt;script&gt;');
  });

  it('HTML-escapes the token-exchange error body in the callback response (no reflected XSS)', async () => {
    const xss = '<script>alert(1)</script>';
    // The token endpoint fails with an attacker-controllable body, which the
    // error message echoes back into the "Token exchange failed" HTML response.
    mswServer.use(
      http.post(`https://${SUB}.zendesk.com/oauth/tokens`, () =>
        HttpResponse.text(xss, { status: 500 }),
      ),
    );

    let resolveBody: (body: string) => void;
    const bodyPromise = new Promise<string>((r) => {
      resolveBody = r;
    });

    openMock.mockImplementation(async (url: string) => {
      const redirectUri = new URL(url).searchParams.get('redirect_uri');
      setImmediate(() => {
        fetch(`${redirectUri}?code=the-auth-code`)
          .then((res) => res.text())
          .then((text) => resolveBody(text))
          .catch(() => resolveBody(''));
      });
      return {};
    });

    await expect(
      authenticateViaBrowser({ subdomain: SUB, oauthClientId: CLIENT_ID, callbackPort: 0 }),
    ).rejects.toThrow(/Token exchange failed/);

    const body = await bodyPromise;
    expect(body).not.toContain(xss);
    expect(body).toContain('&lt;script&gt;');
  });

  it('logs the failure (with platform diagnostics) instead of swallowing it when open rejects', async () => {
    mswServer.use(oauthTokenHandler);

    const errorEvents: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn((event: string, fields?: Record<string, unknown>) => {
        errorEvents.push({ event, fields });
      }),
      attachServer: vi.fn(),
    };

    // The browser fails to open (the #60 symptom). The flow must NOT crash: the
    // user can still complete auth by visiting the URL, so we drive the callback
    // ourselves to let the promise resolve.
    openMock.mockImplementation(async (url: string) => {
      const redirectUri = new URL(url).searchParams.get('redirect_uri');
      setImmediate(() => {
        fetch(`${redirectUri}?code=the-auth-code`).catch(() => {});
      });
      throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
    });

    const result = await authenticateViaBrowser(
      { subdomain: SUB, oauthClientId: CLIENT_ID, callbackPort: 0 },
      logger,
    );

    expect(result.access_token).toBe('token-abc');
    const failure = errorEvents.find((e) => e.event === 'oauth_browser_open_failed');
    expect(failure).toBeDefined();
    expect(failure?.fields?.['error']).toBe('spawn failed');
    expect(failure?.fields?.['errorCode']).toBe('ENOENT');
    expect(failure?.fields?.['platform']).toBe(process.platform);
    // Environment presence is reported as booleans (never values).
    expect(typeof failure?.fields?.['hasSystemRoot']).toBe('boolean');
  });
});

describe('startBrowserAuth', () => {
  beforeEach(() => {
    openMock.mockReset();
    callbackServers.length = 0;
  });

  it('stops the callback server and cancels the timeout once the flow completes', async () => {
    mswServer.use(oauthTokenHandler);
    const logger = makeLogger();
    // Only the two timer functions are faked: the flow below needs real loopback
    // I/O and real `setImmediate` to reach the callback.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      openMock.mockImplementation(async (url: string) => {
        const redirectUri = new URL(url).searchParams.get('redirect_uri');
        setImmediate(() => {
          fetch(`${redirectUri}?code=the-auth-code`).catch(() => {});
        });
        return {};
      });

      const started = await startBrowserAuth(
        { subdomain: SUB, oauthClientId: CLIENT_ID, callbackPort: 0 },
        logger,
      );
      await started.tokenPromise;

      // The port is released as soon as the callback is answered — a server left
      // listening would block the next auth attempt with EADDRINUSE.
      const server = lastCallbackServer();
      await awaitClosed(server);
      expect(server.listening).toBe(false);

      // And the 5-minute timer is gone, so a completed auth cannot emit a
      // spurious `oauth_timeout` minutes later.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(logger.error).not.toHaveBeenCalledWith('oauth_timeout', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 404 on any path but /callback, leaving the flow waiting', async () => {
    mswServer.use(oauthTokenHandler);
    openMock.mockResolvedValue({});

    const started = await startBrowserAuth({
      subdomain: SUB,
      oauthClientId: CLIENT_ID,
      callbackPort: 0,
    });
    const redirectUri = new URL(started.authorizeUrl).searchParams.get('redirect_uri') ?? '';
    const origin = new URL(redirectUri).origin;

    // Browsers ask for /favicon.ico unprompted; that must not be mistaken for a
    // callback, and must not settle or tear down anything.
    const res = await fetch(`${origin}/favicon.ico`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');

    const server = lastCallbackServer();
    expect(server.listening).toBe(true);

    // The real callback still works afterwards, which is the point of not tearing down.
    await fetch(`${redirectUri}?code=the-auth-code`);
    await expect(started.tokenPromise).resolves.toMatchObject({ access_token: 'token-abc' });
    await awaitClosed(server);
  });

  it('rejects the token promise and stops the server when the callback server errors after listening', async () => {
    const logger = makeLogger();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      openMock.mockResolvedValue({});

      const started = await startBrowserAuth(
        { subdomain: SUB, oauthClientId: CLIENT_ID, callbackPort: 0 },
        logger,
      );
      const server = lastCallbackServer();

      // A socket-level failure once we are already listening: `started` has
      // resolved, so the error has to settle the *token* promise instead — else
      // the token store waits on a promise that never settles.
      const boom = Object.assign(new Error('socket exploded'), { code: 'ECONNRESET' });
      const rejection = expect(started.tokenPromise).rejects.toBe(boom);
      server.emit('error', boom);
      await rejection;

      await awaitClosed(server);
      expect(server.listening).toBe(false);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(logger.error).not.toHaveBeenCalledWith('oauth_timeout', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with an actionable message (and logs it) when the callback port is in use', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as { port: number }).port;
    const logger = makeLogger();

    try {
      const err = await startBrowserAuth(
        { subdomain: SUB, oauthClientId: CLIENT_ID, callbackPort: port },
        logger,
      ).catch((e) => e as Error);

      // The raw EADDRINUSE is rewrapped into guidance both the user and the LLM
      // can act on: which port, which env var, and the Zendesk redirect URL.
      expect(err.message).toMatch(/EADDRINUSE/);
      expect(err.message).toContain(String(port));
      expect(err.message).toContain('ZENDESK_OAUTH_CALLBACK_PORT');
      expect(err.message).toContain('/callback');
      expect(logger.error).toHaveBeenCalledWith(
        'oauth_callback_listen_failed',
        expect.objectContaining({ port, errorCode: 'EADDRINUSE' }),
      );
      expect(openMock).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('rejects the token promise after the auth timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      openMock.mockResolvedValue({});
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        attachServer: vi.fn(),
      };
      const started = await startBrowserAuth(
        { subdomain: SUB, oauthClientId: CLIENT_ID, callbackPort: 0 },
        logger,
      );
      const rejection = expect(started.tokenPromise).rejects.toThrow('timed out');

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await rejection;

      expect(logger.error).toHaveBeenCalledWith('oauth_timeout', expect.anything());
      // The timeout also releases the port, so a retry is not blocked by the
      // abandoned attempt.
      const server = lastCallbackServer();
      await awaitClosed(server);
      expect(server.listening).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('refreshAccessToken', () => {
  it('exchanges a refresh token for a rotated access/refresh token pair', async () => {
    mswServer.use(
      http.post(`https://${SUB}.zendesk.com/oauth/tokens`, async ({ request }) => {
        const params = new URLSearchParams(await request.text());
        expect(params.get('grant_type')).toBe('refresh_token');
        expect(params.get('refresh_token')).toBe('old-refresh');
        expect(params.get('client_id')).toBe(CLIENT_ID);
        // Public PKCE client → no client secret.
        expect(params.get('client_secret')).toBeNull();
        return HttpResponse.json({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          token_type: 'bearer',
          scope: 'read write',
          expires_in: 3600,
        });
      }),
    );

    const result = await refreshAccessToken({
      subdomain: SUB,
      oauthClientId: CLIENT_ID,
      refreshToken: 'old-refresh',
    });

    expect(result.access_token).toBe('new-access');
    expect(result.refresh_token).toBe('new-refresh');
    expect(result.expires_in).toBe(3600);
  });

  it('throws when the refresh token is rejected', async () => {
    mswServer.use(
      http.post(`https://${SUB}.zendesk.com/oauth/tokens`, () =>
        HttpResponse.text('invalid_grant', { status: 400 }),
      ),
    );

    await expect(
      refreshAccessToken({ subdomain: SUB, oauthClientId: CLIENT_ID, refreshToken: 'dead' }),
    ).rejects.toThrow(/Token refresh failed \(400\)/);
  });
});
