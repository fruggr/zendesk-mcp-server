import { readFileSync } from 'node:fs';
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
});
