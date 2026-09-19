import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory filesystem backing the mocked `node:fs`, so these tests never touch
// the real disk. `node:fs` is also used by readPackageInfo (imported indirectly),
// which then falls back to the default scoped package name — giving a
// deterministic `fruggr/zendesk-mcp-server` config segment.
const files = new Map<string, string>();
const chmodCalls: Array<{ path: string; mode: number }> = [];
let failWrite = false;
// Set to make the *directory* chmod fail, which the writer treats as best-effort.
let failDirChmod = false;

vi.mock('node:fs', () => ({
  readFileSync: (p: string) => {
    const v = files.get(p);
    if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return v;
  },
  writeFileSync: (p: string, data: string) => {
    if (failWrite) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    files.set(p, String(data));
  },
  renameSync: (from: string, to: string) => {
    const v = files.get(from);
    if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    files.set(to, v);
    files.delete(from);
  },
  rmSync: (p: string) => {
    files.delete(p);
  },
  mkdirSync: () => undefined,
  chmodSync: (p: string, mode: number) => {
    if (failDirChmod && !p.endsWith('.tmp')) {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    }
    chmodCalls.push({ path: p, mode });
  },
}));

const realPlatform = process.platform;
const setPlatform = (p: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { value: p, configurable: true });

const importFresh = async () => {
  vi.resetModules();
  return import('../../../src/auth/token-persistence');
};

// The default-shaped key: the client id `config.ts` derives when
// ZENDESK_OAUTH_CLIENT_ID is unset, and the scope a read-write server requests.
const KEY = { subdomain: 'acme', oauthClientId: 'acme_zendesk', scope: 'read write' } as const;
const keyWith = (overrides: Partial<typeof KEY>) => ({ ...KEY, ...overrides });

describe('token-persistence', () => {
  beforeEach(() => {
    files.clear();
    chmodCalls.length = 0;
    failWrite = false;
    failDirChmod = false;
    delete process.env['ZENDESK_TOKEN_FILE'];
    delete process.env['XDG_CONFIG_HOME'];
    delete process.env['APPDATA'];
  });

  afterEach(() => {
    setPlatform(realPlatform);
    vi.resetModules();
  });

  it('resolves the path from ZENDESK_TOKEN_FILE whatever the key', async () => {
    process.env['ZENDESK_TOKEN_FILE'] = '/custom/token.json';
    const { resolveTokenPath } = await importFresh();
    expect(resolveTokenPath(KEY)).toBe('/custom/token.json');
    // The override is a single explicit file: it outranks every key dimension,
    // which is what makes it the escape hatch for two accounts on one client.
    expect(resolveTokenPath(keyWith({ scope: 'read', oauthClientId: 'other' }))).toBe(
      '/custom/token.json',
    );
  });

  it('separates two servers that differ only in requested scope', async () => {
    setPlatform('linux');
    process.env['XDG_CONFIG_HOME'] = '/home/u/.config';
    const { resolveTokenPath } = await importFresh();

    // The issue #300 report: a `--read-only` instance beside a read-write one.
    // Sharing a file let the read-only server inherit a write-capable token and
    // let either one delete the other's record on a rotated refresh token.
    expect(resolveTokenPath(KEY)).not.toBe(resolveTokenPath(keyWith({ scope: 'read' })));
  });

  it('separates two servers that differ only in OAuth client id', async () => {
    setPlatform('linux');
    process.env['XDG_CONFIG_HOME'] = '/home/u/.config';
    const { resolveTokenPath } = await importFresh();

    // A refresh token minted for one client is rejected by the other, and the
    // rejection deletes the file — so these must never be the same record.
    expect(resolveTokenPath(KEY)).not.toBe(
      resolveTokenPath(keyWith({ oauthClientId: 'acme_readonly' })),
    );
  });

  it('gives each subdomain its own file under the config dir on non-Windows', async () => {
    setPlatform('linux');
    process.env['XDG_CONFIG_HOME'] = '/home/u/.config';
    const { resolveTokenPath } = await importFresh();
    expect(resolveTokenPath(KEY)).not.toBe(resolveTokenPath(keyWith({ subdomain: 'other' })));
    expect(resolveTokenPath(KEY)).toMatch(
      /^\/home\/u\/\.config\/fruggr\/zendesk-mcp-server\/acme--acme_zendesk--read_write--[0-9a-f]{8}\.json$/,
    );
  });

  it('returns the same path for the same key', async () => {
    setPlatform('linux');
    process.env['XDG_CONFIG_HOME'] = '/home/u/.config';
    const { resolveTokenPath } = await importFresh();
    expect(resolveTokenPath(KEY)).toBe(resolveTokenPath(keyWith({})));
  });

  it('sanitizes unsafe characters in every key part', async () => {
    setPlatform('linux');
    process.env['XDG_CONFIG_HOME'] = '/home/u/.config';
    const { resolveTokenPath } = await importFresh();
    expect(resolveTokenPath(keyWith({ subdomain: '../evil', oauthClientId: 'a/b' }))).toMatch(
      /\/zendesk-mcp-server\/___evil--a_b--read_write--[0-9a-f]{8}\.json$/,
    );
  });

  it('separates keys whose sanitized names would collide', async () => {
    setPlatform('linux');
    process.env['XDG_CONFIG_HOME'] = '/home/u/.config';
    const { resolveTokenPath } = await importFresh();

    // Sanitizing maps every unsafe character to `_`, so it is not injective:
    // without the digest these two clients would share one file, recreating the
    // very bug this keying exists to remove.
    expect(resolveTokenPath(keyWith({ oauthClientId: 'a b' }))).not.toBe(
      resolveTokenPath(keyWith({ oauthClientId: 'a_b' })),
    );
  });

  it('separates keys whose parts concatenate to the same string', async () => {
    setPlatform('linux');
    process.env['XDG_CONFIG_HOME'] = '/home/u/.config';
    const { resolveTokenPath } = await importFresh();

    // Both keys are `x…xabread` once the parts run together, and both readable
    // names truncate to the same 120 `x`s — so only a delimiter *inside* the
    // digested key tells them apart. Without one, a client id could be made to
    // impersonate the tail of a subdomain and land on its file.
    const stem = 'x'.repeat(130);
    expect(resolveTokenPath({ subdomain: `${stem}a`, oauthClientId: 'b', scope: 'read' })).not.toBe(
      resolveTokenPath({ subdomain: stem, oauthClientId: 'ab', scope: 'read' }),
    );
  });

  it('separates keys that differ only in case, which Windows would fold', async () => {
    setPlatform('win32');
    process.env['APPDATA'] = 'C:\\Users\\u\\AppData\\Roaming';
    const { resolveTokenPath } = await importFresh();

    const lower = resolveTokenPath(keyWith({ oauthClientId: 'client' })).toLowerCase();
    const upper = resolveTokenPath(keyWith({ oauthClientId: 'CLIENT' })).toLowerCase();
    expect(lower).not.toBe(upper);
  });

  it('caps the filename, keeping the digest, when a key part is very long', async () => {
    setPlatform('linux');
    process.env['XDG_CONFIG_HOME'] = '/home/u/.config';
    const { resolveTokenPath } = await importFresh();

    const long = 'c'.repeat(500);
    const name = resolveTokenPath(keyWith({ oauthClientId: long }))
      .split('/')
      .at(-1) as string;
    // 120 readable chars + '--' + 8 digest chars + '.json'.
    expect(name.length).toBe(135);
    expect(name).toMatch(/--[0-9a-f]{8}\.json$/);
    // Truncation is not injective, so the digest is what keeps the two apart.
    expect(resolveTokenPath(keyWith({ oauthClientId: long }))).not.toBe(
      resolveTokenPath(keyWith({ oauthClientId: `${long}c` })),
    );
  });

  it('uses %APPDATA% and the namespaced segments on Windows', async () => {
    setPlatform('win32');
    process.env['APPDATA'] = 'C:\\Users\\u\\AppData\\Roaming';
    const { resolveTokenPath } = await importFresh();
    const path = resolveTokenPath(KEY);
    expect(path).toContain('fruggr');
    expect(path).toContain('zendesk-mcp-server');
    expect(path).toMatch(/acme--acme_zendesk--read_write--[0-9a-f]{8}\.json$/);
  });

  it('saves then loads a single token record, writing atomically with 0600 perms', async () => {
    setPlatform('linux');
    const path = '/cfg/acme.json';
    const { saveToken, loadToken } = await importFresh();

    saveToken(path, { accessToken: 'a', refreshToken: 'r', expiresAt: 123, scope: 'read' });

    expect(loadToken(path)).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 123,
      scope: 'read',
    });
    // Written to a temp file (chmod 0600) then renamed onto the final path.
    expect(chmodCalls.some((c) => c.path.endsWith('.tmp') && c.mode === 0o600)).toBe(true);
  });

  it('tightens the enclosing config dir to 0700 on non-Windows', async () => {
    setPlatform('linux');
    const { saveToken } = await importFresh();

    saveToken('/cfg/acme.json', { accessToken: 'a' });

    // The token file itself is 0600 (asserted above); the dir holding every
    // subdomain's token is narrowed to owner-only in the same write.
    expect(chmodCalls).toContainEqual({ path: '/cfg', mode: 0o700 });
  });

  it('still writes the token when tightening the config dir is refused', async () => {
    setPlatform('linux');
    failDirChmod = true;
    const { saveToken, loadToken } = await importFresh();

    // Best-effort: a dir we cannot chmod (shared/managed config root) must not
    // cost the user their token.
    expect(() => saveToken('/cfg/acme.json', { accessToken: 'a' })).not.toThrow();
    expect(loadToken('/cfg/acme.json')?.accessToken).toBe('a');
    // The 0600 on the file still happened — only the dir chmod was refused.
    expect(chmodCalls.some((c) => c.path.endsWith('.tmp') && c.mode === 0o600)).toBe(true);
    expect(chmodCalls.some((c) => c.mode === 0o700)).toBe(false);
  });

  it('keeps subdomains isolated in separate files (no shared read-modify-write)', async () => {
    const { saveToken, loadToken } = await importFresh();

    saveToken('/cfg/a.json', { accessToken: 'ta' });
    saveToken('/cfg/b.json', { accessToken: 'tb' });

    expect(loadToken('/cfg/a.json')?.accessToken).toBe('ta');
    expect(loadToken('/cfg/b.json')?.accessToken).toBe('tb');
  });

  it('clear removes the token file', async () => {
    const path = '/cfg/acme.json';
    const { saveToken, clearToken, loadToken } = await importFresh();
    saveToken(path, { accessToken: 'x' });

    clearToken(path);
    expect(loadToken(path)).toBeUndefined();
  });

  it('returns undefined for a missing file', async () => {
    const { loadToken } = await importFresh();
    expect(loadToken('/cfg/missing.json')).toBeUndefined();
  });

  it('treats corrupt JSON as no token', async () => {
    files.set('/cfg/bad.json', '{not json');
    const { loadToken } = await importFresh();
    expect(loadToken('/cfg/bad.json')).toBeUndefined();
  });

  it('never throws when the write fails', async () => {
    failWrite = true;
    const { saveToken } = await importFresh();
    expect(() => saveToken('/cfg/acme.json', { accessToken: 'x' })).not.toThrow();
  });

  it('does not chmod on Windows', async () => {
    setPlatform('win32');
    const { saveToken } = await importFresh();
    saveToken('C:\\cfg\\acme.json', { accessToken: 'x' });
    expect(chmodCalls.length).toBe(0);
  });
});
