import { beforeEach, describe, expect, it, vi } from 'vitest';

type TokenResult = { access_token: string; refresh_token?: string };

const startBrowserAuthMock =
  vi.fn<
    (config: { subdomain: string; oauthClientId: string }) => Promise<{
      authorizeUrl: string;
      tokenPromise: Promise<TokenResult>;
    }>
  >();

vi.mock('../../../src/auth/browser-oauth', () => ({
  startBrowserAuth: (config: { subdomain: string; oauthClientId: string }) =>
    startBrowserAuthMock(config),
}));

// Imported after vi.mock so the mocked browser flow is bound.
const { createTokenStore, AuthRequiredError } = await import('../../../src/auth/token-store');

const CONFIG = { subdomain: 'testsubdomain', oauthClientId: 'test_client' };
const AUTH_URL = 'https://testsubdomain.zendesk.com/oauth/authorizations/new?client_id=test_client';

// A started-auth result whose token promise the test controls.
const deferredStarted = () => {
  let resolveToken!: (t: TokenResult) => void;
  let rejectToken!: (e: unknown) => void;
  const tokenPromise = new Promise<TokenResult>((res, rej) => {
    resolveToken = res;
    rejectToken = rej;
  });
  return { started: { authorizeUrl: AUTH_URL, tokenPromise }, resolveToken, rejectToken };
};

// Flush the microtask + immediate queue so the store's token-promise handlers run.
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createTokenStore', () => {
  beforeEach(() => {
    startBrowserAuthMock.mockReset();
  });

  it('returns a token set via setToken without triggering the browser flow', async () => {
    const store = createTokenStore(CONFIG);
    store.setToken('preset-token');

    await expect(store.getToken()).resolves.toBe('preset-token');
    expect(startBrowserAuthMock).not.toHaveBeenCalled();
  });

  it('fails fast with the authorize URL when no token is present', async () => {
    startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
    const store = createTokenStore(CONFIG);

    const err = await store.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthRequiredError);
    expect((err as AuthRequiredError).authorizeUrl).toBe(AUTH_URL);
    expect((err as Error).message).toContain(AUTH_URL);
    expect(startBrowserAuthMock).toHaveBeenCalledWith(CONFIG);
  });

  it('returns the cached token once the background flow completes, then retry succeeds', async () => {
    const { started, resolveToken } = deferredStarted();
    startBrowserAuthMock.mockResolvedValue(started);
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).rejects.toBeInstanceOf(AuthRequiredError);

    resolveToken({ access_token: 'fresh-token', refresh_token: 'refresh-abc' });
    await flush();

    await expect(store.getToken()).resolves.toBe('fresh-token');
    expect(startBrowserAuthMock).toHaveBeenCalledTimes(1);
  });

  it('starts only one browser flow for concurrent first calls', async () => {
    startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
    const store = createTokenStore(CONFIG);

    const results = await Promise.allSettled([store.getToken(), store.getToken()]);

    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    for (const r of results) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AuthRequiredError);
    }
    expect(startBrowserAuthMock).toHaveBeenCalledTimes(1);
  });

  it('restarts the flow after a failed/timed-out attempt', async () => {
    const first = deferredStarted();
    startBrowserAuthMock
      .mockResolvedValueOnce(first.started)
      .mockResolvedValueOnce(deferredStarted().started);
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).rejects.toBeInstanceOf(AuthRequiredError);
    first.rejectToken(new Error('user closed browser'));
    await flush();

    await expect(store.getToken()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(startBrowserAuthMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a start failure (e.g. port in use) and allows a later retry', async () => {
    startBrowserAuthMock
      .mockRejectedValueOnce(new Error('listen EADDRINUSE'))
      .mockResolvedValueOnce(deferredStarted().started);
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).rejects.toThrow('EADDRINUSE');
    await expect(store.getToken()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(startBrowserAuthMock).toHaveBeenCalledTimes(2);
  });
});
