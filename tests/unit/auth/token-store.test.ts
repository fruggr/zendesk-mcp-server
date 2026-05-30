import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticateViaBrowserMock =
  vi.fn<
    (config: {
      subdomain: string;
      oauthClientId: string;
    }) => Promise<{ access_token: string; refresh_token?: string }>
  >();

vi.mock('../../../src/auth/browser-oauth', () => ({
  authenticateViaBrowser: (config: { subdomain: string; oauthClientId: string }) =>
    authenticateViaBrowserMock(config),
}));

// Imported after vi.mock so the mocked browser flow is bound.
const { createTokenStore } = await import('../../../src/auth/token-store');

const CONFIG = { subdomain: 'testsubdomain', oauthClientId: 'test_client' };

describe('createTokenStore', () => {
  beforeEach(() => {
    authenticateViaBrowserMock.mockReset();
  });

  it('returns a token set via setToken without triggering the browser flow', async () => {
    const store = createTokenStore(CONFIG);
    store.setToken('preset-token');

    await expect(store.getToken()).resolves.toBe('preset-token');
    expect(authenticateViaBrowserMock).not.toHaveBeenCalled();
  });

  it('authenticates via the browser when no token is present', async () => {
    authenticateViaBrowserMock.mockResolvedValue({
      access_token: 'fresh-token',
      refresh_token: 'refresh-abc',
    });

    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).resolves.toBe('fresh-token');
    expect(authenticateViaBrowserMock).toHaveBeenCalledWith(CONFIG);
  });

  it('caches the token so the browser flow runs only once across calls', async () => {
    authenticateViaBrowserMock.mockResolvedValue({ access_token: 'fresh-token' });

    const store = createTokenStore(CONFIG);
    await store.getToken();
    await store.getToken();

    expect(authenticateViaBrowserMock).toHaveBeenCalledTimes(1);
  });

  it('shares a single in-flight auth promise for concurrent callers', async () => {
    let resolveAuth!: (value: { access_token: string }) => void;
    authenticateViaBrowserMock.mockReturnValue(
      new Promise((resolve) => {
        resolveAuth = resolve;
      }),
    );

    const store = createTokenStore(CONFIG);
    const first = store.getToken();
    const second = store.getToken();
    resolveAuth({ access_token: 'shared-token' });

    await expect(Promise.all([first, second])).resolves.toEqual(['shared-token', 'shared-token']);
    expect(authenticateViaBrowserMock).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight promise on failure so a retry re-authenticates', async () => {
    authenticateViaBrowserMock
      .mockRejectedValueOnce(new Error('user closed browser'))
      .mockResolvedValueOnce({ access_token: 'retry-token' });

    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).rejects.toThrow('user closed browser');
    await expect(store.getToken()).resolves.toBe('retry-token');
    expect(authenticateViaBrowserMock).toHaveBeenCalledTimes(2);
  });
});
