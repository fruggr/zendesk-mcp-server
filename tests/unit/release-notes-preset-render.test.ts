import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error - plain JS semantic-release plugin, no type declarations
import { generateNotes } from '../../scripts/release-notes-collapsed.js';

/**
 * End-to-end guard for the release-notes pipeline.
 *
 * Unlike `release-notes-collapsed.test.ts` (which feeds hand-written markdown to
 * the pure `collapseInternalSections` helper), this test drives the REAL
 * `conventional-changelog-conventionalcommits` preset through
 * `@semantic-release/release-notes-generator` with the exact `presetConfig` that
 * ships in `.releaserc.json`, then through our collapsing wrapper.
 *
 * It is a deliberate compatibility canary: the conventionalcommits preset must
 * stay on a generation whose `writerOpts` the resolved
 * `conventional-changelog-writer` can render. Preset v10 replaced Handlebars
 * template strings with render functions, which only writer 9 understands, while
 * `@semantic-release/release-notes-generator` still declares
 * `conventional-changelog-writer@^8` — writer 8 finds no `mainTemplate` and emits
 * *only* the version header. The pairing therefore holds solely because
 * `pnpm-workspace.yaml` overrides the writer to `^9`.
 *
 * These assertions are the tripwire if that pairing breaks again: a lockfile regen
 * that drops the override, or an upstream major moving the writer past 9. They fail
 * loudly instead of shipping empty changelogs. See `docs/release-automation.md`
 * ("Preset / writer version coupling") for the removal condition.
 */

// The collapsing plugin is the 2nd `.releaserc.json` plugin entry: [path, options].
const rc = JSON.parse(readFileSync(new URL('../../.releaserc.json', import.meta.url), 'utf8')) as {
  plugins: Array<unknown>;
};
const pluginConfig = (
  rc.plugins.find(
    (p): p is [string, Record<string, unknown>] =>
      Array.isArray(p) && String(p[0]).includes('release-notes-collapsed'),
  ) as [string, Record<string, unknown>]
)[1];

const commit = (hash: string, message: string) => ({
  hash,
  message,
  author: { name: 'Test', email: 'test@example.com' },
  committerDate: '2026-06-27T00:00:00Z',
});

const context = {
  commits: [
    commit('aaaaaaa', 'feat(tickets): add bulk update tool'),
    commit('bbbbbbb', 'fix(auth): handle expired token refresh'),
    commit('ccccccc', 'docs(readme): document the new flag'),
    commit('ddddddd', 'chore(deps): bump a dependency'),
    commit('eeeeeee', 'ci: pin an action sha'),
  ],
  lastRelease: { version: '1.0.0', gitTag: 'v1.0.0', gitHead: '0000000' },
  nextRelease: { version: '1.1.0', gitTag: 'v1.1.0', type: 'minor', gitHead: 'eeeeeee' },
  options: { repositoryUrl: 'https://github.com/fruggr/zendesk-mcp-server' },
  cwd: process.cwd(),
  env: {},
  logger: { log: () => {}, error: () => {} },
};

describe('release notes preset rendering (compatibility canary)', () => {
  let notes: string;
  beforeAll(async () => {
    notes = await generateNotes(pluginConfig, context);
  });

  it('renders public sections from the conventionalcommits preset', () => {
    // The whole point: the preset must actually render commit sections, not just
    // the `## [version]` header. An incompatible preset generation yields only
    // the header, so these would be missing.
    expect(notes).toContain('### Features');
    expect(notes).toContain('### Bug Fixes');
    expect(notes).toContain('add bulk update tool');
  });

  it('keeps internal types in the changelog, collapsed inside a <details> block', () => {
    // Internal types must still be rendered (so they can be collapsed) and tucked
    // behind the <details> panel, after the public sections.
    expect(notes).toContain('<details>');
    const detailsIdx = notes.indexOf('<details>');
    expect(notes.indexOf('### Features')).toBeLessThan(detailsIdx);
    expect(notes.indexOf('### Chores')).toBeGreaterThan(detailsIdx);
    expect(notes.indexOf('### Continuous Integration')).toBeGreaterThan(detailsIdx);
  });
});
