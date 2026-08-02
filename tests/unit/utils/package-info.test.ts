import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const REAL_PKG = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

describe('readPackageInfo', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('returns the name and version from the package own package.json', async () => {
    vi.resetModules();
    const { readPackageInfo } = await import('../../../src/utils/package-info');

    const info = readPackageInfo();

    expect(info.name).toBe(REAL_PKG.name);
    expect(info.version).toBe(REAL_PKG.version);
  });

  it('falls back to safe defaults when no package.json can be read', async () => {
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      readFileSync: () => {
        throw new Error('ENOENT');
      },
    }));
    const { readPackageInfo } = await import('../../../src/utils/package-info');

    const info = readPackageInfo();

    expect(info).toEqual({ name: '@fruggr/zendesk-mcp-server', version: '0.0.0' });
  });

  it('reads package.json once and serves later calls from the cache', async () => {
    // createMcpServer runs several times per process (notably across tests);
    // the walk must not be repeated each time.
    vi.resetModules();
    const readMock = vi.fn(() => JSON.stringify({ name: 'cached-pkg', version: '1.2.3' }));
    vi.doMock('node:fs', () => ({ readFileSync: readMock }));
    const { readPackageInfo } = await import('../../../src/utils/package-info');

    expect(readPackageInfo()).toEqual({ name: 'cached-pkg', version: '1.2.3' });
    expect(readPackageInfo()).toEqual({ name: 'cached-pkg', version: '1.2.3' });
    expect(readMock).toHaveBeenCalledTimes(1);
  });

  it('walks up one directory at a time until a package.json is readable', async () => {
    vi.resetModules();
    const attempted: string[] = [];
    const readMock = vi.fn((path: string) => {
      attempted.push(path);
      if (attempted.length < 3) throw new Error('ENOENT');
      return JSON.stringify({ name: 'found-upstairs', version: '4.5.6' });
    });
    vi.doMock('node:fs', () => ({ readFileSync: readMock }));
    const { readPackageInfo } = await import('../../../src/utils/package-info');

    expect(readPackageInfo()).toEqual({ name: 'found-upstairs', version: '4.5.6' });
    expect(attempted).toHaveLength(3);
    // Each attempt targets the parent of the previous one — a walk, not a retry.
    const dirs = attempted.map((path) => dirname(path));
    expect(dirs[1]).toBe(dirname(dirs[0] as string));
    expect(dirs[2]).toBe(dirname(dirs[1] as string));
  });

  it('keeps walking past a package.json that is valid JSON but not an object', async () => {
    vi.resetModules();
    let call = 0;
    vi.doMock('node:fs', () => ({
      readFileSync: () => {
        call += 1;
        return call === 1 ? '"not an object"' : JSON.stringify({ name: 'real', version: '7.0.0' });
      },
    }));
    const { readPackageInfo } = await import('../../../src/utils/package-info');

    expect(readPackageInfo()).toEqual({ name: 'real', version: '7.0.0' });
  });

  it('keeps walking past a package.json missing name or version', async () => {
    // A nested package.json without a version (common in fixture dirs) must not
    // satisfy the walk and strand the server on a partial identity.
    vi.resetModules();
    const payloads = [
      JSON.stringify({ name: 'no-version' }),
      JSON.stringify({ version: '0.1.0' }),
      JSON.stringify({ name: 'complete', version: '8.0.0' }),
    ];
    vi.doMock('node:fs', () => ({ readFileSync: () => payloads.shift() ?? '{}' }));
    const { readPackageInfo } = await import('../../../src/utils/package-info');

    expect(readPackageInfo()).toEqual({ name: 'complete', version: '8.0.0' });
  });
});
