import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory filesystem backing the mocked `node:fs`, so these tests never touch
// the real disk. `node:fs` is also used by readPackageInfo (imported indirectly),
// which then falls back to the default scoped package name — giving a
// deterministic `fruggr/zendesk-mcp-server` config segment.
const files = new Map<string, string>();
const chmodCalls: Array<{ path: string; mode: number }> = [];
let failWrite = false;

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

describe('token-persistence', () => {
  beforeEach(() => {
    files.clear();
    chmodCalls.length = 0;
    failWrite = false;
    delete process.env['ZENDESK_TOKEN_FILE'];
    delete process.env['XDG_CONFIG_HOME'];
    delete process.env['APPDATA'];
  });

  afterEach(() => {
    setPlatform(realPlatform);
    vi.resetModules();
  });

  it('resolves the path from ZENDESK_TOKEN_FILE when set', async () => {
    process.env['ZENDESK_TOKEN_FILE'] = '/custom/token.json';
    const { resolveTokenPath } = await importFresh();
    expect(resolveTokenPath('acme')).toBe('/custom/token.json');
  });

  it('gives each subdomain its own file under the config dir on non-Windows', async () => {
    setPlatform('linux');
    process.env['XDG_CONFIG_HOME'] = '/home/u/.config';
    const { resolveTokenPath } = await importFresh();
    expect(resolveTokenPath('acme')).toBe('/home/u/.config/fruggr/zendesk-mcp-server/acme.json');
    expect(resolveTokenPath('other')).toBe('/home/u/.config/fruggr/zendesk-mcp-server/other.json');
  });

  it('sanitizes unsafe characters in the subdomain filename', async () => {
    setPlatform('linux');
    process.env['XDG_CONFIG_HOME'] = '/home/u/.config';
    const { resolveTokenPath } = await importFresh();
    expect(resolveTokenPath('../evil')).toBe(
      '/home/u/.config/fruggr/zendesk-mcp-server/___evil.json',
    );
  });

  it('uses %APPDATA% and the namespaced segments on Windows', async () => {
    setPlatform('win32');
    process.env['APPDATA'] = 'C:\\Users\\u\\AppData\\Roaming';
    const { resolveTokenPath } = await importFresh();
    const path = resolveTokenPath('acme');
    expect(path).toContain('fruggr');
    expect(path).toContain('zendesk-mcp-server');
    expect(path).toContain('acme.json');
  });

  it('saves then loads a single token record, writing atomically with 0600 perms', async () => {
    setPlatform('linux');
    const path = '/cfg/acme.json';
    const { saveToken, loadToken } = await importFresh();

    saveToken(path, { accessToken: 'a', refreshToken: 'r', expiresAt: 123 });

    expect(loadToken(path)).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 123 });
    // Written to a temp file (chmod 0600) then renamed onto the final path.
    expect(chmodCalls.some((c) => c.path.endsWith('.tmp') && c.mode === 0o600)).toBe(true);
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
