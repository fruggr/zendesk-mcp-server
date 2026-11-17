import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSignInRequired } from '../../../src/utils/sign-in-required';

interface TokenResult {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  // The granted scope, which a refresh response may omit (RFC 6749 5.1).
  scope?: string;
}

const startBrowserAuthMock =
  vi.fn<
    (config: { subdomain: string; oauthClientId: string; readOnly: boolean }) => Promise<{
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
  startBrowserAuth: (config: { subdomain: string; oauthClientId: string; readOnly: boolean }) =>
    startBrowserAuthMock(config),
  refreshAccessToken: (config: {
    subdomain: string;
    oauthClientId: string;
    refreshToken: string;
  }) => refreshAccessTokenMock(config),
}));

// Persistence is mocked so the unit tests never touch the real filesystem; the
// store's disk interactions are asserted through these spies. They keep one
// record per path, like the files they stand for: the store re-reads the file
// to see what a sibling process wrote, so a disk that forgot writes would lie.
const disk = new Map<string, unknown>();
const loadTokenMock = vi.fn((path: string) => disk.get(path));
const saveTokenMock = vi.fn((path: string, record: unknown, _logger?: unknown): boolean => {
  disk.set(path, record);
  return true;
});
const clearTokenMock = vi.fn((path: string, _logger?: unknown) => {
  disk.delete(path);
});
const RW_PATH = '/tmp/testsubdomain--test_client--read_write.json';
const RO_PATH = '/tmp/testsubdomain--test_client--read.json';
// What a store finds on disk at startup, whichever surface it serves.
const seedDisk = (record: unknown) => {
  disk.set(RW_PATH, record);
  disk.set(RO_PATH, record);
};
// Another read-write server process sharing the file writes its own record.
const siblingWrites = (record: unknown) => disk.set(RW_PATH, record);

// Mirrors the real keying closely enough to prove the store addresses a file
// per credential; the derivation itself is token-persistence.test.ts's job.
vi.mock('../../../src/auth/token-persistence', () => ({
  resolveTokenPath: (key: { subdomain: string; oauthClientId: string; scope: string }) =>
    `/tmp/${key.subdomain}--${key.oauthClientId}--${key.scope.replace(' ', '_')}.json`,
  loadToken: (path: string) => loadTokenMock(path),
  saveToken: (path: string, record: unknown, logger: unknown) =>
    saveTokenMock(path, record, logger),
  clearToken: (path: string, logger: unknown) => clearTokenMock(path, logger),
}));

// Imported after vi.mock so the mocked deps are bound.
const { createAuthRequiredError, createTokenStore, isAuthRequiredError, SIBLING_SETTLE_MS } =
  await import('../../../src/auth/token-store');

const CONFIG = { subdomain: 'testsubdomain', oauthClientId: 'test_client', readOnly: false };
// Same tenant, read-only surface: the store must then ask for the `read` scope
// and accept a broader token it finds on disk.
const RO_CONFIG = { ...CONFIG, readOnly: true };
const FUTURE = () => Date.now() + 60 * 60 * 1000;
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

const makeLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

// Flush the microtask + immediate queue so the store's token-promise handlers run.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const FOUR_HOURS = 4 * 60 * 60 * 1000;

// What refreshAccessToken throws when Zendesk refuses the refresh token.
const refused = (message: string) => Object.assign(new Error(message), { status: 400 });

// A refresh response the test settles, to hold a refresh in flight.
const deferredRefresh = () => Promise.withResolvers<TokenResult>();

describe('isAuthRequiredError', () => {
  it('needs an Error, the AuthRequiredError name and an authorize URL, all three', () => {
    expect(isAuthRequiredError(createAuthRequiredError(AUTH_URL))).toBe(true);
    expect(isAuthRequiredError({ name: 'AuthRequiredError', authorizeUrl: AUTH_URL })).toBe(false);
    expect(isAuthRequiredError(Object.assign(new Error('x'), { authorizeUrl: AUTH_URL }))).toBe(
      false,
    );
    expect(isAuthRequiredError(Object.assign(new Error('x'), { name: 'AuthRequiredError' }))).toBe(
      false,
    );
  });
});

describe('createTokenStore', () => {
  beforeEach(() => {
    startBrowserAuthMock.mockReset();
    refreshAccessTokenMock.mockReset();
    disk.clear();
    loadTokenMock.mockClear();
    saveTokenMock.mockClear();
    clearTokenMock.mockClear();
  });

  it('serves the token current when getToken is called, not one installed after', async () => {
    const store = createTokenStore(CONFIG);
    store.setToken('first');

    const call = store.getToken();
    store.setToken('second');

    await expect(call).resolves.toBe('first');
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
    // MCP surfaces this as the tool-call error text: it is what the user reads.
    expect((err as Error).message).toMatchInlineSnapshot(`
      "Zendesk authentication required. A browser window should have opened for you to sign in. If it did not, open this URL in your browser, then retry your request:
      https://testsubdomain.zendesk.com/oauth/authorizations/new?client_id=test_client"
    `);
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

  it('persists to a different file for the read-only and read-write surfaces', async () => {
    createTokenStore(CONFIG).setToken('rw-access');
    createTokenStore(RO_CONFIG).setToken('ro-access');

    // Issue #300: one record for both surfaces let the read-only server inherit
    // a write-capable token from its read-write sibling.
    expect(saveTokenMock.mock.calls.map(([path]) => path)).toEqual([
      '/tmp/testsubdomain--test_client--read_write.json',
      '/tmp/testsubdomain--test_client--read.json',
    ]);
  });

  it('clears only its own record when its refresh token is rejected', async () => {
    refreshAccessTokenMock.mockRejectedValue(refused('refresh token rotated out'));
    startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
    const store = createTokenStore(RO_CONFIG);
    store.setToken('ro-access', 'ro-refresh');

    await expect(store.getToken()).rejects.toThrow('authentication required');

    // The other half of #300: the loser of a rotation race used to delete the
    // shared file, taking its sibling's still-valid token with it. Assert the
    // whole call list, not just a matching call -- clearing a sibling *as well*
    // is the regression, and `toHaveBeenCalledWith` would pass through it.
    expect(clearTokenMock.mock.calls.map(([path]) => path)).toEqual([
      '/tmp/testsubdomain--test_client--read.json',
    ]);
  });

  it('reuses a token loaded from disk without starting a browser flow', async () => {
    seedDisk({ accessToken: 'disk-token' });
    const logger = makeLogger();
    const store = createTokenStore(CONFIG, logger);

    await expect(store.getToken()).resolves.toBe('disk-token');
    expect(startBrowserAuthMock).not.toHaveBeenCalled();
    // The counterpart of oauth_token_scope_insufficient: a record that was
    // accepted has to be visible in the logs too, or a start that skipped
    // sign-in is indistinguishable from one that had no record at all.
    expect(logger.debug).toHaveBeenCalledWith('oauth_token_loaded_from_disk');
  });

  it('forwards the configured callback port to the browser flow', async () => {
    startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
    const store = createTokenStore({ ...CONFIG, callbackPort: 51000 });

    await store.getToken().catch(() => {});
    expect(startBrowserAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ callbackPort: 51000 }),
    );
  });

  it('forwards the read-only lever to the browser flow', async () => {
    startBrowserAuthMock.mockResolvedValue(deferredStarted().started);

    await createTokenStore(RO_CONFIG)
      .getToken()
      .catch(() => {});
    expect(startBrowserAuthMock).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));

    startBrowserAuthMock.mockClear();
    await createTokenStore(CONFIG)
      .getToken()
      .catch(() => {});
    expect(startBrowserAuthMock).toHaveBeenCalledWith(expect.objectContaining({ readOnly: false }));
  });

  it('re-authenticates when the cached grant does not cover the requested scope', async () => {
    // A `read` token cannot be widened: OAuth forbids a refresh from granting
    // more than it was given, so the only way out is a new authorization.
    seedDisk({
      accessToken: 'ro',
      refreshToken: 'r1',
      scope: 'read',
      expiresAt: FUTURE(),
    });
    startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
    const logger = makeLogger();
    const store = createTokenStore(CONFIG, logger);

    await expect(store.getToken()).rejects.toThrow('authentication required');
    expect(startBrowserAuthMock).toHaveBeenCalledTimes(1);
    // Why the sign-in happened has to be visible in the logs, or a narrowed
    // OAuth client looks like a random re-prompt.
    expect(logger.warn).toHaveBeenCalledWith('oauth_token_scope_insufficient', {
      requested: 'read write',
      granted: 'read',
    });
    // Refreshing would mint an equally narrow token and burn the single-use
    // refresh token on every call.
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    // The record may still be exactly right for a read-only sibling process, and
    // a successful sign-in overwrites the file anyway.
    expect(clearTokenMock).not.toHaveBeenCalled();
  });

  it('keeps a broader cached token when running read-only', async () => {
    seedDisk({
      accessToken: 'rw',
      refreshToken: 'r1',
      scope: 'read write',
      expiresAt: FUTURE(),
    });
    const store = createTokenStore(RO_CONFIG);

    await expect(store.getToken()).resolves.toBe('rw');
    expect(startBrowserAuthMock).not.toHaveBeenCalled();
  });

  it('treats a record with no scope as the read write grant it was minted under', async () => {
    seedDisk({ accessToken: 'legacy', expiresAt: FUTURE() });
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).resolves.toBe('legacy');
    expect(startBrowserAuthMock).not.toHaveBeenCalled();
  });

  it('records the granted scope reported by the browser flow', async () => {
    const { started, resolveToken } = deferredStarted();
    startBrowserAuthMock.mockResolvedValue(started);
    const store = createTokenStore(RO_CONFIG);

    await expect(store.getToken()).rejects.toThrow('authentication required');
    resolveToken({ access_token: 'fresh', refresh_token: 'r1', scope: 'read' });
    await flush();

    expect(saveTokenMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ accessToken: 'fresh', scope: 'read' }),
      expect.anything(),
    );
  });

  it('falls back to the requested scope when the flow reports none', async () => {
    const { started, resolveToken } = deferredStarted();
    startBrowserAuthMock.mockResolvedValue(started);
    const store = createTokenStore(RO_CONFIG);

    await expect(store.getToken()).rejects.toThrow('authentication required');
    resolveToken({ access_token: 'fresh', refresh_token: 'r1' });
    await flush();

    expect(saveTokenMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ scope: 'read' }),
      expect.anything(),
    );
  });

  it('keeps the previous grant when the refresh response omits the scope', async () => {
    seedDisk({
      accessToken: 'old',
      refreshToken: 'r1',
      scope: 'read',
      expiresAt: Date.now() - 1000,
    });
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'new', refresh_token: 'r2' });
    const store = createTokenStore(RO_CONFIG);

    await expect(store.getToken()).resolves.toBe('new');
    expect(saveTokenMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ accessToken: 'new', scope: 'read' }),
      expect.anything(),
    );
  });

  it('serves a freshly minted token even when Zendesk granted less than asked', async () => {
    // The alternative is a browser window on every single tool call: a new
    // authorization would grant exactly the same narrow scope. Writes then fail
    // with 403 from Zendesk, which is the pre-#283 behaviour.
    const { started, resolveToken } = deferredStarted();
    startBrowserAuthMock.mockResolvedValue(started);
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).rejects.toThrow('authentication required');
    resolveToken({ access_token: 'narrow', refresh_token: 'r1', scope: 'read' });
    await flush();

    await expect(store.getToken()).resolves.toBe('narrow');
    expect(startBrowserAuthMock).toHaveBeenCalledTimes(1);
  });

  it('warns when a minted grant falls short of what was requested', async () => {
    const { started, resolveToken } = deferredStarted();
    startBrowserAuthMock.mockResolvedValue(started);
    const logger = makeLogger();
    const store = createTokenStore(CONFIG, logger);

    await expect(store.getToken()).rejects.toThrow('authentication required');
    resolveToken({ access_token: 'narrow', refresh_token: 'r1', scope: 'read' });
    await flush();

    // Served anyway -- the warning is the only thing standing between the
    // operator and unexplained 403s on every write.
    expect(logger.warn).toHaveBeenCalledWith('oauth_token_grant_narrowed', {
      requested: 'read write',
      granted: 'read',
    });
    await expect(store.getToken()).resolves.toBe('narrow');
  });

  it('stays quiet when the granted scope covers the request', async () => {
    const { started, resolveToken } = deferredStarted();
    startBrowserAuthMock.mockResolvedValue(started);
    const logger = makeLogger();
    const store = createTokenStore(RO_CONFIG, logger);

    await expect(store.getToken()).rejects.toThrow('authentication required');
    resolveToken({ access_token: 'wide', refresh_token: 'r1', scope: 'read write' });
    await flush();

    expect(logger.warn).not.toHaveBeenCalledWith('oauth_token_grant_narrowed', expect.anything());
  });

  it('serves a refreshed token rather than rotating for a grant that cannot widen', async () => {
    seedDisk({
      accessToken: 'old',
      refreshToken: 'r1',
      scope: 'read write',
      expiresAt: Date.now() - 1000,
    });
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'narrowed', scope: 'read' });
    startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).resolves.toBe('narrowed');
    expect(startBrowserAuthMock).not.toHaveBeenCalled();
  });

  it('records an empty reported scope as unchanged rather than as a grant of nothing', async () => {
    seedDisk({
      accessToken: 'old',
      refreshToken: 'r1',
      scope: 'read write',
      expiresAt: Date.now() - 1000,
    });
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'new', scope: '' });
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).resolves.toBe('new');
    expect(saveTokenMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ scope: 'read write' }),
      expect.anything(),
    );
  });

  it('records the requested scope for a token installed through setToken', async () => {
    const store = createTokenStore(RO_CONFIG);
    store.setToken('preset');

    expect(saveTokenMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ accessToken: 'preset', scope: 'read' }),
      expect.anything(),
    );
  });

  it('preserves the recorded grant when invalidating an access token', async () => {
    seedDisk({
      accessToken: 'rw',
      refreshToken: 'r1',
      scope: 'read write',
      expiresAt: FUTURE(),
    });
    const store = createTokenStore(CONFIG);

    store.invalidate();

    expect(saveTokenMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ scope: 'read write', expiresAt: 0 }),
      expect.anything(),
    );
  });

  it('refreshes silently when the cached token is expired, persisting the rotated refresh token', async () => {
    seedDisk({
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
    seedDisk({
      accessToken: 'old',
      refreshToken: 'bad',
      expiresAt: Date.now() - 1000,
    });
    refreshAccessTokenMock.mockRejectedValue(refused('Token refresh failed (400): invalid_grant'));
    startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
    const store = createTokenStore(CONFIG);

    const err = await store.getToken().catch((e) => e);
    expect(isAuthRequiredError(err)).toBe(true);
    expect(clearTokenMock).toHaveBeenCalledWith(expect.any(String), expect.anything());
    expect(startBrowserAuthMock).toHaveBeenCalledTimes(1);
  });

  describe('getTokenSilently', () => {
    it('serves the token in hand without any browser flow', async () => {
      const store = createTokenStore(CONFIG);
      store.setToken('preset-token');

      await expect(store.getTokenSilently()).resolves.toBe('preset-token');
      expect(startBrowserAuthMock).not.toHaveBeenCalled();
    });

    it('refreshes an expired token silently', async () => {
      seedDisk({
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

      await expect(store.getTokenSilently()).resolves.toBe('new');
      expect(startBrowserAuthMock).not.toHaveBeenCalled();
    });

    it('never opens a browser when only a sign-in would help', async () => {
      seedDisk({
        accessToken: 'old',
        refreshToken: 'bad',
        expiresAt: Date.now() - 1000,
      });
      refreshAccessTokenMock.mockRejectedValue(
        refused('Token refresh failed (400): invalid_grant'),
      );
      const store = createTokenStore(CONFIG);

      const err = await store.getTokenSilently().catch((e) => e);
      expect(isSignInRequired(err)).toBe(true);
      expect(isAuthRequiredError(err)).toBe(false);
      await expect(createTokenStore(CONFIG).getTokenSilently()).rejects.toThrow(
        'Not signed in to Zendesk',
      );
      expect(startBrowserAuthMock).not.toHaveBeenCalled();
    });
  });

  it('invalidate drops the in-memory and persisted token when there is no refresh token', async () => {
    seedDisk({ accessToken: 'live' });
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).resolves.toBe('live');

    // Nothing to renew it with: a replay could only prompt for a sign-in.
    expect(store.invalidate()).toBe(false);
    expect(clearTokenMock).toHaveBeenCalledWith(expect.any(String), expect.anything());

    startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
    await expect(store.getToken()).rejects.toThrow('authentication required');
  });

  it('invalidate keeps the refresh token so the next call can refresh silently', async () => {
    seedDisk({ accessToken: 'old', refreshToken: 'r1' });
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'new', refresh_token: 'r2' });
    const store = createTokenStore(CONFIG);

    // A silent refresh is one call away, so the failed read may be replayed.
    expect(store.invalidate()).toBe(true);
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

  it('proactively refreshes a stored token with no expiresAt before serving it', async () => {
    // A token minted before Zendesk enabled expiration has no expiresAt; it must
    // be refreshed ahead of use, not served until a 401 forces recovery.
    seedDisk({ accessToken: 'old', refreshToken: 'r1' });
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
    expect(startBrowserAuthMock).not.toHaveBeenCalled();
  });

  it('probe-refreshes an unknown-expiry token only once, then trusts it', async () => {
    // Refresh response also omits expires_in → the new token still has no
    // expiresAt. We must not refresh on every subsequent call.
    seedDisk({ accessToken: 'old', refreshToken: 'r1' });
    refreshAccessTokenMock.mockResolvedValue({ access_token: 'new', refresh_token: 'r2' });
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).resolves.toBe('new');
    await expect(store.getToken()).resolves.toBe('new');
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
  });

  it('probe-refreshes a token set via setToken even after an earlier probe', async () => {
    // The disk token gets probe-refreshed once, marking the store's probe state.
    // A token later installed via setToken has unknown age, so it must be probed
    // too — the probe state must not leak across tokens.
    seedDisk({ accessToken: 'old', refreshToken: 'r1' });
    refreshAccessTokenMock.mockResolvedValueOnce({
      access_token: 'refreshed',
      refresh_token: 'r2',
      expires_in: 3600,
    });
    const store = createTokenStore(CONFIG);

    await expect(store.getToken()).resolves.toBe('refreshed');

    refreshAccessTokenMock.mockResolvedValueOnce({
      access_token: 'reprobed',
      refresh_token: 'r4',
      expires_in: 3600,
    });
    store.setToken('preset', 'r3');

    await expect(store.getToken()).resolves.toBe('reprobed');
    expect(refreshAccessTokenMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ refreshToken: 'r3' }),
    );
  });

  it('coalesces concurrent refreshes into a single network round-trip', async () => {
    // Zendesk rotates the refresh token on every use, so two concurrent refreshes
    // would invalidate each other — the refresh must be exclusive.
    seedDisk({
      accessToken: 'old',
      refreshToken: 'r1',
      expiresAt: Date.now() - 1000,
    });
    let resolveRefresh!: (r: TokenResult) => void;
    refreshAccessTokenMock.mockReturnValue(
      new Promise<TokenResult>((res) => {
        resolveRefresh = res;
      }),
    );
    const store = createTokenStore(CONFIG);

    const calls = Promise.all([store.getToken(), store.getToken(), store.getToken()]);
    resolveRefresh({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 });

    await expect(calls).resolves.toEqual(['new', 'new', 'new']);
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes in the background before an idle token can go stale', async () => {
    vi.useFakeTimers();
    try {
      seedDisk({
        accessToken: 'old',
        refreshToken: 'r1',
        // Far from expiry, so getToken alone would never refresh.
        expiresAt: Date.now() + 12 * 60 * 60 * 1000,
      });
      refreshAccessTokenMock.mockResolvedValueOnce({
        access_token: 'new',
        refresh_token: 'r2',
        expires_in: 3600,
      });
      refreshAccessTokenMock.mockResolvedValueOnce({
        access_token: 'newer',
        refresh_token: 'r3',
        expires_in: 3600,
      });
      const store = createTokenStore(CONFIG);

      await vi.advanceTimersByTimeAsync(FOUR_HOURS - 1);
      expect(refreshAccessTokenMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
      expect(refreshAccessTokenMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ refreshToken: 'r1' }),
      );

      // Every period, not once: each run must release the slot for the next.
      await vi.advanceTimersByTimeAsync(FOUR_HOURS);
      expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
      expect(refreshAccessTokenMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ refreshToken: 'r2' }),
      );
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the existing token when a background refresh fails transiently', async () => {
    vi.useFakeTimers();
    try {
      seedDisk({
        accessToken: 'live',
        refreshToken: 'r1',
        // Far from expiry: the background refresh runs preemptively while the
        // token is still perfectly usable.
        expiresAt: Date.now() + 12 * 60 * 60 * 1000,
      });
      refreshAccessTokenMock.mockRejectedValue(new Error('Token refresh failed (503)'));
      const store = createTokenStore(CONFIG);

      await vi.advanceTimersByTimeAsync(FOUR_HOURS);

      // A transient failure must not wipe a still-valid token or force re-auth.
      expect(clearTokenMock).not.toHaveBeenCalled();
      await expect(store.getToken()).resolves.toBe('live');
      expect(startBrowserAuthMock).not.toHaveBeenCalled();
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose stops the background refresh timer', async () => {
    vi.useFakeTimers();
    try {
      seedDisk({
        accessToken: 'old',
        refreshToken: 'r1',
        expiresAt: Date.now() + 12 * 60 * 60 * 1000,
      });
      refreshAccessTokenMock.mockResolvedValue({
        access_token: 'new',
        refresh_token: 'r2',
        expires_in: 3600,
      });
      const store = createTokenStore(CONFIG);
      store.dispose();

      await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);

      expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the expiry a refresh reports, and none when it reports none', async () => {
    vi.useFakeTimers();
    try {
      const expired = { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000 };
      seedDisk(expired);
      refreshAccessTokenMock.mockResolvedValueOnce({ access_token: 'a', expires_in: 3600 });
      const timed = createTokenStore(CONFIG);
      await expect(timed.getToken()).resolves.toBe('a');
      expect(saveTokenMock).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ expiresAt: Date.now() + 3_600_000 }),
        expect.anything(),
      );
      timed.dispose();

      // A fresh start from the same expired record, not a sibling of `timed`.
      seedDisk(expired);
      refreshAccessTokenMock.mockResolvedValueOnce({ access_token: 'b' });
      const untimed = createTokenStore(CONFIG);
      await expect(untimed.getToken()).resolves.toBe('b');
      expect(saveTokenMock).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ expiresAt: undefined }),
        expect.anything(),
      );
      untimed.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes from the first millisecond of the skew window, not one before', async () => {
    vi.useFakeTimers();
    try {
      refreshAccessTokenMock.mockResolvedValue({ access_token: 'new', expires_in: 3600 });

      seedDisk({
        accessToken: 'outside',
        refreshToken: 'r1',
        expiresAt: Date.now() + 60_001,
      });
      const outside = createTokenStore(CONFIG);
      await expect(outside.getToken()).resolves.toBe('outside');
      outside.dispose();

      seedDisk({
        accessToken: 'inside',
        refreshToken: 'r1',
        expiresAt: Date.now() + 60_000,
      });
      const inside = createTokenStore(CONFIG);
      await expect(inside.getToken()).resolves.toBe('new');
      inside.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a call during a background refresh and serves the token it mints', async () => {
    vi.useFakeTimers();
    try {
      seedDisk({
        accessToken: 'old',
        refreshToken: 'r1',
        expiresAt: Date.now() + 12 * 60 * 60 * 1000,
      });
      const background = deferredRefresh();
      refreshAccessTokenMock.mockReturnValueOnce(background.promise);
      const store = createTokenStore(CONFIG);

      await vi.advanceTimersByTimeAsync(FOUR_HOURS);
      // 'old' is still valid, but r1 is about to be rotated out from under it.
      const call = store.getToken();
      background.resolve({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 });

      await expect(call).resolves.toBe('new');
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one on-demand refresh between callers a failed background refresh released', async () => {
    vi.useFakeTimers();
    try {
      seedDisk({
        accessToken: 'old',
        refreshToken: 'r1',
        // Inside the skew window by the time the background tick fires.
        expiresAt: Date.now() + FOUR_HOURS + 30_000,
      });
      const background = deferredRefresh();
      refreshAccessTokenMock
        .mockReturnValueOnce(background.promise)
        .mockResolvedValueOnce({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 });
      const store = createTokenStore(CONFIG);

      await vi.advanceTimersByTimeAsync(FOUR_HOURS);
      const calls = Promise.all([store.getToken(), store.getToken()]);
      background.reject(new Error('Token refresh failed (503)'));

      await expect(calls).resolves.toEqual(['new', 'new']);
      expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the background tick while an on-demand refresh is in flight', async () => {
    vi.useFakeTimers();
    try {
      seedDisk({
        accessToken: 'old',
        refreshToken: 'r1',
        expiresAt: Date.now() - 1000,
      });
      const onDemand = deferredRefresh();
      refreshAccessTokenMock.mockReturnValueOnce(onDemand.promise);
      const store = createTokenStore(CONFIG);

      const call = store.getToken();
      await vi.advanceTimersByTimeAsync(FOUR_HOURS);
      expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);

      onDemand.resolve({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 });
      await expect(call).resolves.toBe('new');
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // Issue #465: one server per project and session, all on one token file. Each
  // keeps its own copy in memory, and Zendesk rotates the refresh token on use.
  describe('sibling processes sharing the token file', () => {
    const EXPIRED = { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() - 1000 };
    const SIBLING = { accessToken: 'sibling', refreshToken: 'r2', expiresAt: FUTURE() };
    const REFUSED = refused('Token refresh failed (400): invalid_grant');

    it('adopts a token a sibling refreshed rather than spend the rotated-out one', async () => {
      seedDisk(EXPIRED);
      const logger = makeLogger();
      const store = createTokenStore(CONFIG, logger);
      siblingWrites(SIBLING);

      await expect(store.getToken()).resolves.toBe('sibling');
      expect(refreshAccessTokenMock).not.toHaveBeenCalled();
      expect(startBrowserAuthMock).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith('oauth_token_adopted_from_sibling');
    });

    it('serves a sign-in a sibling completed instead of opening another browser', async () => {
      const store = createTokenStore(CONFIG);
      siblingWrites(SIBLING);

      await expect(store.getToken()).resolves.toBe('sibling');
      expect(startBrowserAuthMock).not.toHaveBeenCalled();
    });

    it('probes an adopted token of unknown expiry once, like one read at startup', async () => {
      const store = createTokenStore(CONFIG);
      siblingWrites({ accessToken: 'sibling', refreshToken: 'r2' });
      refreshAccessTokenMock.mockResolvedValue({ access_token: 'probed', refresh_token: 'r3' });

      await expect(store.getToken()).resolves.toBe('probed');
      await expect(store.getToken()).resolves.toBe('probed');
      expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
      expect(refreshAccessTokenMock).toHaveBeenCalledWith(
        expect.objectContaining({ refreshToken: 'r2' }),
      );
    });

    it('keeps its own token when the file holds an older one it failed to replace', async () => {
      seedDisk(EXPIRED);
      refreshAccessTokenMock.mockResolvedValueOnce({
        access_token: 'mine',
        refresh_token: 'r2',
        expires_in: 0,
      });
      // The write of the refreshed token fails: the file keeps the old record.
      saveTokenMock.mockReturnValueOnce(false);
      const store = createTokenStore(CONFIG);
      await expect(store.getToken()).resolves.toBe('mine');

      refreshAccessTokenMock.mockResolvedValueOnce({ access_token: 'next', refresh_token: 'r3' });
      await expect(store.getToken()).resolves.toBe('next');
      expect(refreshAccessTokenMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ refreshToken: 'r2' }),
      );
    });

    it('takes the sibling record on a 401 rather than write its stale one over it', async () => {
      seedDisk({ accessToken: 'live', refreshToken: 'r1', expiresAt: FUTURE() });
      const store = createTokenStore(CONFIG);
      siblingWrites(SIBLING);

      expect(store.invalidate()).toBe(true);
      expect(disk.get(RW_PATH)).toEqual(SIBLING);
      await expect(store.getToken()).resolves.toBe('sibling');
      expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    });

    it('does not wait for a sibling when the refresh failed for want of a network', async () => {
      vi.useFakeTimers();
      try {
        seedDisk(EXPIRED);
        refreshAccessTokenMock.mockRejectedValue(new Error('fetch failed'));
        startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
        const store = createTokenStore(CONFIG);

        let settled = false;
        void store.getToken().catch(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(true);
        store.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('takes a refresh that rejected with no error object for an outage', async () => {
      seedDisk(EXPIRED);
      refreshAccessTokenMock.mockRejectedValue(null);
      startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
      const store = createTokenStore({ ...CONFIG, siblingSettleMs: 0 });

      await expect(store.getToken()).rejects.toThrow('authentication required');
      expect(disk.get(RW_PATH)).toEqual(EXPIRED);
    });

    it('keeps the credential, here and for its siblings, across a network error', async () => {
      seedDisk(EXPIRED);
      refreshAccessTokenMock
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce({ access_token: 'new', refresh_token: 'r2' });
      startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
      const store = createTokenStore(CONFIG);

      await expect(store.getToken()).rejects.toThrow('authentication required');
      expect(clearTokenMock).not.toHaveBeenCalled();
      expect(disk.get(RW_PATH)).toEqual(EXPIRED);

      await expect(store.getToken()).resolves.toBe('new');
      expect(refreshAccessTokenMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ refreshToken: 'r1' }),
      );
    });

    it('waits for a sibling on a 401 refusal too', async () => {
      vi.useFakeTimers();
      try {
        seedDisk(EXPIRED);
        refreshAccessTokenMock.mockRejectedValue(Object.assign(new Error('x'), { status: 401 }));
        const store = createTokenStore(CONFIG);

        const call = store.getToken();
        await vi.advanceTimersByTimeAsync(SIBLING_SETTLE_MS - 1);
        siblingWrites(SIBLING);
        await vi.advanceTimersByTimeAsync(1);
        await expect(call).resolves.toBe('sibling');
        store.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('refreshes an adopted token that is itself stale, with its own refresh token', async () => {
      const store = createTokenStore(CONFIG);
      siblingWrites({ ...EXPIRED, refreshToken: 'r2' });
      refreshAccessTokenMock.mockResolvedValue({ access_token: 'new', refresh_token: 'r3' });

      await expect(store.getToken()).resolves.toBe('new');
      expect(refreshAccessTokenMock).toHaveBeenCalledWith(
        expect.objectContaining({ refreshToken: 'r2' }),
      );
    });

    it('ignores a sibling record whose grant does not cover this server', async () => {
      startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
      const store = createTokenStore(CONFIG);
      siblingWrites({ ...SIBLING, scope: 'read' });

      await expect(store.getToken()).rejects.toThrow('authentication required');
    });

    it('keeps the winner of a rotation race, without waiting, when it wrote first', async () => {
      vi.useFakeTimers();
      try {
        seedDisk(EXPIRED);
        refreshAccessTokenMock.mockImplementation(async () => {
          siblingWrites(SIBLING);
          throw REFUSED;
        });
        const store = createTokenStore(CONFIG);

        const call = store.getToken();
        let served: string | undefined;
        void call.then((t) => {
          served = t;
        });
        // No timer advanced: a record already on disk is adopted at once.
        await vi.advanceTimersByTimeAsync(0);
        expect(served).toBe('sibling');
        expect(clearTokenMock).not.toHaveBeenCalled();
        expect(disk.get(RW_PATH)).toEqual(SIBLING);
        store.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits for the winner of a rotation race to write its token', async () => {
      vi.useFakeTimers();
      try {
        seedDisk(EXPIRED);
        refreshAccessTokenMock.mockRejectedValue(REFUSED);
        startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
        const store = createTokenStore(CONFIG);

        const call = store.getToken();
        await vi.advanceTimersByTimeAsync(SIBLING_SETTLE_MS - 1);
        siblingWrites(SIBLING);
        await vi.advanceTimersByTimeAsync(1);

        await expect(call).resolves.toBe('sibling');
        expect(startBrowserAuthMock).not.toHaveBeenCalled();
        expect(clearTokenMock).not.toHaveBeenCalled();
        store.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('signs in again but leaves a record it does not own on disk', async () => {
      seedDisk(EXPIRED);
      const narrow = { ...SIBLING, scope: 'read' };
      refreshAccessTokenMock.mockImplementation(async () => {
        siblingWrites(narrow);
        throw REFUSED;
      });
      startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
      const store = createTokenStore({ ...CONFIG, siblingSettleMs: 0 });

      await expect(store.getToken()).rejects.toThrow('authentication required');
      expect(clearTokenMock).not.toHaveBeenCalled();
      expect(disk.get(RW_PATH)).toEqual(narrow);
    });

    it('signs in again when the refused record vanished from disk meanwhile', async () => {
      seedDisk(EXPIRED);
      refreshAccessTokenMock.mockImplementation(async () => {
        disk.delete(RW_PATH);
        throw REFUSED;
      });
      startBrowserAuthMock.mockResolvedValue(deferredStarted().started);
      const store = createTokenStore({ ...CONFIG, siblingSettleMs: 0 });

      await expect(store.getToken()).rejects.toThrow('authentication required');
      expect(clearTokenMock).not.toHaveBeenCalled();
    });

    it('keeps refreshing in the background, with the refresh token a sibling left', async () => {
      vi.useFakeTimers();
      try {
        seedDisk({
          accessToken: 'live',
          refreshToken: 'r1',
          expiresAt: Date.now() + 12 * 3600_000,
        });
        refreshAccessTokenMock.mockResolvedValue({
          access_token: 'kept-alive',
          refresh_token: 'r3',
          expires_in: 12 * 3600,
        });
        const store = createTokenStore(CONFIG);
        siblingWrites({ ...SIBLING, expiresAt: Date.now() + 12 * 3600_000 });

        await vi.advanceTimersByTimeAsync(FOUR_HOURS);
        expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
        expect(refreshAccessTokenMock).toHaveBeenCalledWith(
          expect.objectContaining({ refreshToken: 'r2' }),
        );
        await expect(store.getToken()).resolves.toBe('kept-alive');
        store.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('adopts the token a sibling wrote while the background refresh was refused', async () => {
      vi.useFakeTimers();
      try {
        const far = Date.now() + 12 * 3600_000;
        seedDisk({ accessToken: 'live', refreshToken: 'r1', expiresAt: far });
        refreshAccessTokenMock.mockImplementation(async () => {
          siblingWrites({ ...SIBLING, expiresAt: far });
          throw REFUSED;
        });
        const store = createTokenStore(CONFIG);

        await vi.advanceTimersByTimeAsync(FOUR_HOURS);
        await expect(store.getToken()).resolves.toBe('sibling');
        store.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('lets the background tick and invalidate run on a store with no token', async () => {
    vi.useFakeTimers();
    try {
      const store = createTokenStore(CONFIG);

      await vi.advanceTimersByTimeAsync(FOUR_HOURS);
      expect(refreshAccessTokenMock).not.toHaveBeenCalled();

      store.invalidate();
      expect(clearTokenMock).toHaveBeenCalledTimes(1);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
