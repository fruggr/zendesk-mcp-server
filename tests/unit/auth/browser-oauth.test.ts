import { createServer } from 'node:http';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { oauthTokenHandler } from '../../msw-handlers';
import { mswServer } from '../../setup';

const openMock = vi.fn<(url: string) => Promise<unknown>>();

vi.mock('open', () => ({
  default: (url: string) => openMock(url),
}));

// Imported after vi.mock so the mocked `open` is bound.
const { authenticateViaBrowser, startBrowserAuth } = await import(
  '../../../src/auth/browser-oauth'
);

const SUB = 'testsubdomain';
const CLIENT_ID = 'test_client';

describe('authenticateViaBrowser', () => {
  beforeEach(() => {
    openMock.mockReset();
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
  });

  it('rejects the start (without opening a browser) when the callback port is in use', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as { port: number }).port;

    try {
      await expect(
        startBrowserAuth({ subdomain: SUB, oauthClientId: CLIENT_ID, callbackPort: port }),
      ).rejects.toThrow(/EADDRINUSE/);
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
    } finally {
      vi.useRealTimers();
    }
  });
});
