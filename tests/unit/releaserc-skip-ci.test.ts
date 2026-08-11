import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the release loop-breaker.
 *
 * `release.yml` authenticates as a GitHub App so it can push the
 * `chore(release)` commit past the ruleset on `main`. An App installation token
 * is a third-party identity, so its pushes DO start workflow runs — the
 * platform exemption that makes the built-in `GITHUB_TOKEN` safe here does not
 * apply to it. The only thing stopping every release from re-triggering Release
 * (and Mutation testing's full-scope job) is the `[skip ci]` marker in the
 * `@semantic-release/git` commit message template.
 *
 * Nothing else would catch its removal. The release itself would still succeed,
 * just pay for a duplicate pipeline on every version, with the cause several
 * files away from the symptom. Hence this assertion. Why the App token is
 * needed at all: `docs/release-automation.md` (Admin prerequisites).
 */

const rc = JSON.parse(readFileSync(new URL('../../.releaserc.json', import.meta.url), 'utf8')) as {
  plugins: unknown[];
};

const gitPluginConfig = rc.plugins.find(
  (p): p is [string, Record<string, unknown>] =>
    Array.isArray(p) && p[0] === '@semantic-release/git',
)?.[1];

describe('.releaserc.json @semantic-release/git', () => {
  it('configures a commit message template', () => {
    expect(gitPluginConfig).toBeDefined();
    expect(typeof gitPluginConfig?.message).toBe('string');
  });

  it('keeps [skip ci] in the literal part of the message, ahead of the release notes', () => {
    const message = gitPluginConfig?.message as string;
    // GitHub accepts the marker anywhere in the commit message, but only the
    // text before `${nextRelease.notes}` is authored here — the notes are
    // generated per release and cannot be relied on to carry it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matches the literal semantic-release placeholder ${nextRelease.notes}
    const literalPrefix = message.split('${nextRelease.notes}')[0];
    expect(literalPrefix).toContain('[skip ci]');
  });
});
