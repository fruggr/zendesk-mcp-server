import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const REAL_PKG = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

const ENOENT = new Error('ENOENT');

/**
 * Load a fresh `package-info` (its result is module-cached, so every case needs
 * its own copy) with `node:fs` stubbed to serve `payloads` to successive reads,
 * throwing for any `Error` entry. The last payload repeats, so a case only has
 * to list the reads it cares about. Returns the spy so tests can assert on the
 * call count and the paths walked.
 */
const loadWithReads = async (payloads: readonly (string | Error)[]) => {
  vi.resetModules();
  let index = 0;
  const readFileSyncMock = vi.fn((_path: string): string => {
    const payload = payloads[Math.min(index++, payloads.length - 1)];
    if (payload instanceof Error) throw payload;
    return payload ?? '';
  });
  vi.doMock('node:fs', () => ({ readFileSync: readFileSyncMock }));
  const { readPackageInfo } = await import('../../../src/utils/package-info');
  return { readPackageInfo, readFileSyncMock };
};

const pkgJson = (pkg: Record<string, string>): string => JSON.stringify(pkg);

// Both loaders mock modules and re-import, so both have to hand the registry back.
const unmockModules = (): void => {
  vi.doUnmock('node:fs');
  vi.doUnmock('node:path');
  vi.resetModules();
};

/**
 * Stub `node:fs` and `node:path` so the walk's two terminators can be told apart:
 * `'endless'` never reaches a fixed point, leaving the depth bound as the only way
 * out, `'shallow'` reaches one after two steps. With the real `dirname` the module's
 * own depth on disk decides which fires first, so no call count would be stable.
 */
const loadWithWalk = async (walk: 'endless' | 'shallow') => {
  vi.resetModules();
  const readFileSyncMock = vi.fn((): string => {
    throw ENOENT;
  });
  vi.doMock('node:fs', () => ({ readFileSync: readFileSyncMock }));
  vi.doMock('node:path', () => ({
    // Both are independent of where the module actually sits on disk -- under
    // Stryker the sandbox adds two levels, which is enough to change a count.
    // 'shallow' collapses any starting point onto the two-step chain /dir -> /.
    dirname: (path: string) => {
      if (walk === 'endless') return `${path}/up`;
      return path === '/dir' || path === '/' ? '/' : '/dir';
    },
    join: (...parts: string[]) => parts.join('/'),
  }));
  const { readPackageInfo } = await import('../../../src/utils/package-info');
  return { readPackageInfo, readFileSyncMock };
};

describe('readPackageInfo', () => {
  afterEach(unmockModules);

  it('returns the name and version from the package own package.json', async () => {
    vi.resetModules();
    const { readPackageInfo } = await import('../../../src/utils/package-info');

    const info = readPackageInfo();

    expect(info.name).toBe(REAL_PKG.name);
    expect(info.version).toBe(REAL_PKG.version);
  });

  it('falls back to safe defaults when no package.json can be read', async () => {
    const { readPackageInfo } = await loadWithReads([ENOENT]);

    expect(readPackageInfo()).toEqual({ name: '@fruggr/zendesk-mcp-server', version: '0.0.0' });
  });

  it('reads package.json once and serves later calls from the cache', async () => {
    // createMcpServer runs several times per process (notably across tests);
    // the walk must not be repeated each time.
    const { readPackageInfo, readFileSyncMock } = await loadWithReads([
      pkgJson({ name: 'cached-pkg', version: '1.2.3' }),
    ]);

    expect(readPackageInfo()).toEqual({ name: 'cached-pkg', version: '1.2.3' });
    expect(readPackageInfo()).toEqual({ name: 'cached-pkg', version: '1.2.3' });
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('walks up one directory at a time until a package.json is readable', async () => {
    const { readPackageInfo, readFileSyncMock } = await loadWithReads([
      ENOENT,
      ENOENT,
      pkgJson({ name: 'found-upstairs', version: '4.5.6' }),
    ]);

    expect(readPackageInfo()).toEqual({ name: 'found-upstairs', version: '4.5.6' });
    expect(readFileSyncMock).toHaveBeenCalledTimes(3);
    // Each attempt targets the parent of the previous one — a walk, not a retry.
    const dirs = readFileSyncMock.mock.calls.map(([path]) => dirname(path));
    expect(dirs.slice(1)).toEqual(dirs.slice(0, -1).map((dir) => dirname(dir)));
  });

  it('keeps walking past a package.json that is valid JSON but not an object', async () => {
    const { readPackageInfo } = await loadWithReads([
      '"not an object"',
      pkgJson({ name: 'real', version: '7.0.0' }),
    ]);

    expect(readPackageInfo()).toEqual({ name: 'real', version: '7.0.0' });
  });

  it('keeps walking past a package.json missing name or version', async () => {
    // A nested package.json without a version (common in fixture dirs) must not
    // satisfy the walk and strand the server on a partial identity.
    const { readPackageInfo } = await loadWithReads([
      pkgJson({ name: 'no-version' }),
      pkgJson({ version: '0.1.0' }),
      pkgJson({ name: 'complete', version: '8.0.0' }),
    ]);

    expect(readPackageInfo()).toEqual({ name: 'complete', version: '8.0.0' });
  });
});

describe('the walk terminates, and on whichever limit comes first', () => {
  afterEach(unmockModules);

  it('gives up after eight levels when the walk never reaches a root', async () => {
    // A bundled install can sit arbitrarily deep, and a symlink or a container
    // mount can make `dirname` climb forever. The depth bound is what keeps a
    // server start from turning into an unbounded scan, and counting down
    // instead of up removes it entirely.
    const { readPackageInfo, readFileSyncMock } = await loadWithWalk('endless');

    expect(readPackageInfo()).toEqual({ name: '@fruggr/zendesk-mcp-server', version: '0.0.0' });
    expect(readFileSyncMock).toHaveBeenCalledTimes(8);
  });

  it('stops at the filesystem root, well before the depth bound', async () => {
    // The other terminator, and the one that fires in a normal install.
    const { readPackageInfo, readFileSyncMock } = await loadWithWalk('shallow');

    expect(readPackageInfo()).toEqual({ name: '@fruggr/zendesk-mcp-server', version: '0.0.0' });
    // Two reads -- one directory, then the root -- and then the break. Without
    // it the walk keeps re-reading `/package.json` up to the depth bound.
    expect(readFileSyncMock).toHaveBeenCalledTimes(2);
    expect(readFileSyncMock.mock.calls.at(-1)?.[0]).toBe('//package.json');
  });

  it('reads package.json as UTF-8, not as a Buffer', async () => {
    // `readFileSync` without an encoding hands back a Buffer, and `JSON.parse`
    // on one works by coercion -- so nothing downstream notices until a
    // multi-byte character in the name comes back mangled.
    const { readPackageInfo, readFileSyncMock } = await loadWithWalk('shallow');
    readPackageInfo();

    expect(readFileSyncMock).toHaveBeenCalledWith(expect.any(String), 'utf8');
  });
});
