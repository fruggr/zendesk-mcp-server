import { beforeEach, describe, expect, it, vi } from 'vitest';

type TokenResult = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

const startBrowserAuthMock =
  vi.fn<
    (config: { subdomain: string; oauthClientId: string }) => Promise<{
      authorizeUrl: string;
      tokenPromise: Promise<TokenResult>;
    }>
  >();

const refreshAccessTokenMock =
  vi.fn<
    (config: {
      subdomain: string;
      oauthClientId: string;
      refreshToken: string;
    }) => Promise<TokenResult>
  >();

vi.mock('../../../src/auth/browser-oauth', () => ({
  startBrowserAuth: (config: { subdomain: string; oauthClientId: string }) =>
    startBrowserAuthMock(config),
  refreshAccessToken: (config: {
    subdomain: string;
    oauthClientId: string;
    refreshToken: string;
  }) => refreshAccessTokenMock(config),
}));

// Persistence is mocked so the unit tests never touch the real filesystem; the
// store's disk interactions are asserted through these spies.
const loadTokenMock = vi.fn<() => unknown>();
const saveTokenMock = vi.fn();
const clearTokenMock = vi.fn();

vi.mock('../../../src/auth/token-persistence', () => ({
  resolveTokenPath: () => '/tmp/fake-token.json',
  loadToken: (...args: unknown[]) => loadTokenMock(...(args as [])),
  saveToken: (...args: unknown[]) => saveTokenMock(...args),
  clearToken: (...args: unknown[]) => clearTokenMock(...args),
}));

// Imported after vi.mock so the mocked deps are bound.
const { createTokenStore, isAuthRequiredError } = await import('../../../src/auth/token-store');

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
    refreshAccessTokenMock.mockReset();
    loadTokenMock.mockReset();
    loadTokenMock.mockReturnValue(undefined);
    saveTokenMock.mockReset();
    clearTokenMock.mockReset();
  });

  it('returns a token set via setToken without triggering the browser flow', async () => {
    const store = createTokenStore(CONFIG);
    store.setToken('preset-token');

    await expect(store.getToken()).resolves.toBe('preset-token');
    expect(startBrowserAuthMock).not.toHaveBeenCalled();
    expect(saveTokenMock).toHaveBeenCalled();
  });

  it('fails fast with the authorize URL when no token is present', async () => {
    startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
    const store = createTokenStore(CONFIG);

    const err = await store.getToken().catch((e) => e);
    expect(isAuthRequiredError(err)).toBe(true);
    expect((err as { authorizeUrl: string }).authorizeUrl).toBe(AUTH_URL);
    expect((err as Error).message).toContain(AUTH_URL);
    expect(startBrowserAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ subdomain: CONFIG.subdomain, oauthClientId: CONFIG.oauthClientId }),
    );
  });

  it('returns the cached token once the background flow completes, then retry succeeds', async () => {
    const { started, resolveToken } = deferredStarted();
    startBrowserAuthMock.mockResolvedValue(started);
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).rejects.toThrow('authentication required');

    resolveToken({ access_token: 'fresh-token', refresh_token: 'refresh-abc' });
    await flush();

    await expect(store.getToken()).resolves.toBe('fresh-token');
    expect(startBrowserAuthMock).toHaveBeenCalledTimes(1);
  });

  it('persists the token to disk after the background flow completes', async () => {
    const { started, resolveToken } = deferredStarted();
    startBrowserAuthMock.mockResolvedValue(started);
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).rejects.toThrow('authentication required');
    resolveToken({ access_token: 'fresh-token', refresh_token: 'refresh-abc' });
    await flush();

    expect(saveTokenMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ accessToken: 'fresh-token', refreshToken: 'refresh-abc' }),
      expect.anything(),
    );
  });

  it('starts only one browser flow for concurrent first calls', async () => {
    startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
    const store = createTokenStore(CONFIG);

    const results = await Promise.allSettled([store.getToken(), store.getToken()]);

    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    for (const r of results) {
      expect(isAuthRequiredError((r as PromiseRejectedResult).reason)).toBe(true);
    }
    expect(startBrowserAuthMock).toHaveBeenCalledTimes(1);
  });

  it('restarts the flow after a failed/timed-out attempt', async () => {
    const first = deferredStarted();
    startBrowserAuthMock
      .mockResolvedValueOnce(first.started)
      .mockResolvedValueOnce(deferredStarted().started);
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).rejects.toThrow('authentication required');
    first.rejectToken(new Error('user closed browser'));
    await flush();

    await expect(store.getToken()).rejects.toThrow('authentication required');
    expect(startBrowserAuthMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a start failure (e.g. port in use) and allows a later retry', async () => {
    startBrowserAuthMock
      .mockRejectedValueOnce(new Error('listen EADDRINUSE'))
      .mockResolvedValueOnce(deferredStarted().started);
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).rejects.toThrow('EADDRINUSE');
    await expect(store.getToken()).rejects.toThrow('authentication required');
    expect(startBrowserAuthMock).toHaveBeenCalledTimes(2);
  });

  it('reuses a token loaded from disk without starting a browser flow', async () => {
    loadTokenMock.mockReturnValue({ accessToken: 'disk-token' });
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).resolves.toBe('disk-token');
    expect(startBrowserAuthMock).not.toHaveBeenCalled();
  });

  it('forwards the configured callback port to the browser flow', async () => {
    startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
    const store = createTokenStore({ ...CONFIG, callbackPort: 51000 });

    await store.getToken().catch(() => {});
    expect(startBrowserAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ callbackPort: 51000 }),
    );
  });

  it('refreshes silently when the cached token is expired, persisting the rotated refresh token', async () => {
    loadTokenMock.mockReturnValue({
      accessToken: 'old',
      refreshToken: 'r1',
      expiresAt: Date.now() - 1000,
    });
    refreshAccessTokenMock.mockResolvedValue({
      access_token: 'new',
      refresh_token: 'r2',
      expires_in: 3600,
    });
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).resolves.toBe('new');
    expect(refreshAccessTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: 'r1' }),
    );
    expect(saveTokenMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ accessToken: 'new', refreshToken: 'r2' }),
      expect.anything(),
    );
    expect(startBrowserAuthMock).not.toHaveBeenCalled();
  });

  it('falls back to the browser flow when the refresh token is rejected', async () => {
    loadTokenMock.mockReturnValue({
      accessToken: 'old',
      refreshToken: 'bad',
      expiresAt: Date.now() - 1000,
    });
    refreshAccessTokenMock.mockRejectedValue(
      new Error('Token refresh failed (400): invalid_grant'),
    );
    startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
    const store = createTokenStore(CONFIG);

    const err = await store.getToken().catch((e) => e);
    expect(isAuthRequiredError(err)).toBe(true);
    expect(clearTokenMock).toHaveBeenCalledWith(expect.any(String), expect.anything());
    expect(startBrowserAuthMock).toHaveBeenCalledTimes(1);
  });

  it('invalidate drops the in-memory and persisted token when there is no refresh token', async () => {
    loadTokenMock.mockReturnValue({ accessToken: 'live' });
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).resolves.toBe('live');

    store.invalidate();
    expect(clearTokenMock).toHaveBeenCalledWith(expect.any(String), expect.anything());

    startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
    await expect(store.getToken()).rejects.toThrow('authentication required');
  });

  it('invalidate keeps the refresh token so the next call can refresh silently', async () => {
    loadTokenMock.mockReturnValue({ accessToken: 'old', refreshToken: 'r1' });
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'new', refresh_token: 'r2' });
    const store = createTokenStore(CONFIG);

    store.invalidate();
    // The record is preserved (persisted), not cleared.
    expect(clearTokenMock).not.toHaveBeenCalled();
    expect(saveTokenMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ refreshToken: 'r1', expiresAt: 0 }),
      expect.anything(),
    );

    // The next call recovers via silent refresh rather than a browser prompt.
    await expect(store.getToken()).resolves.toBe('new');
    expect(refreshAccessTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: 'r1' }),
    );
    expect(startBrowserAuthMock).not.toHaveBeenCalled();
  });
});
