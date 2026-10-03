import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The release job builds dist/ before semantic-release picks the version, and
 * @semantic-release/npm publishes dist/ without rebuilding it. dist/sbom.cdx.json
 * names the package version, so dist/ is rebuilt in a prepare step that runs
 * after @semantic-release/npm has written the new version to package.json.
 */

const rc = JSON.parse(readFileSync(new URL('../../.releaserc.json', import.meta.url), 'utf8')) as {
  plugins: unknown[];
};

const pluginName = (p: unknown): unknown => (Array.isArray(p) ? p[0] : p);
const indexOf = (name: string): number => rc.plugins.findIndex((p) => pluginName(p) === name);

describe('.releaserc.json rebuild before publishing', () => {
  it('rebuilds dist/ in a prepare step after @semantic-release/npm bumps the version', () => {
    const exec = rc.plugins[indexOf('@semantic-release/exec')] as [string, { prepareCmd: string }];
    expect(indexOf('@semantic-release/exec')).toBeGreaterThan(indexOf('@semantic-release/npm'));
    expect(exec[1].prepareCmd).toMatch(/&& pnpm build$/);
  });
});
