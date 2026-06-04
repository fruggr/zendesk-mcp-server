import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readPackageInfo } from '../../../src/utils/package-info';

describe('readPackageInfo', () => {
  it('returns the name and version from the package own package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { name: string; version: string };

    const info = readPackageInfo();

    expect(info.name).toBe(pkg.name);
    expect(info.version).toBe(pkg.version);
  });
});
