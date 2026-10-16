import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `scripts/git-retry/git` stands in for git on PATH during semantic-release, so
 * a transient GitHub refusal of one push (the 3.3.1 note, `remote: fatal error
 * in commit_refs`) no longer ends a release halfway. The real git here is a
 * stub that logs its argv and fails its first `FAIL_TIMES` calls.
 */

const repoRoot = new URL('../../', import.meta.url);
const wrapper = new URL('scripts/git-retry/git', repoRoot).pathname;

const FAKE_GIT = `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
n=$(wc -l < "$CALLS")
if [ "$n" -le "\${FAIL_TIMES:-0}" ]; then
  echo "remote: fatal error in commit_refs" >&2
  exit 1
fi
echo ok
`;

let sandbox: string;
let calls: string;
let realGit: string;

const run = (args: string[], failTimes = 0) =>
  spawnSync(wrapper, args, {
    env: {
      ...process.env,
      REAL_GIT: realGit,
      CALLS: calls,
      FAIL_TIMES: String(failTimes),
      GIT_PUSH_RETRY_DELAYS: '0 0 0',
    },
    encoding: 'utf8',
  });

const loggedCalls = () => readFileSync(calls, 'utf8').trimEnd().split('\n');

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'git-retry-'));
  calls = join(sandbox, 'calls.log');
  realGit = join(sandbox, 'git');
  writeFileSync(calls, '');
  writeFileSync(realGit, FAKE_GIT);
  chmodSync(realGit, 0o755);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('git retry wrapper (scripts/git-retry/git)', () => {
  it('passes any command but push straight through, failures included', () => {
    const result = run(['tag', 'v1.2.3', 'HEAD'], 1);
    expect(result.status).toBe(1);
    expect(loggedCalls()).toEqual(['tag v1.2.3 HEAD']);
  });

  it('runs a push that succeeds once, with its arguments untouched', () => {
    const result = run(['push', '--', 'https://example/repo.git', 'refs/notes/x']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok\n');
    expect(loggedCalls()).toEqual(['push -- https://example/repo.git refs/notes/x']);
  });

  it('does not retry a dry-run push, which semantic-release expects to fail', () => {
    const result = run(
      ['push', '--dry-run', '--no-verify', '--', 'https://example/repo.git', 'HEAD:main'],
      9,
    );
    expect(result.status).toBe(1);
    expect(loggedCalls()).toEqual([
      'push --dry-run --no-verify -- https://example/repo.git HEAD:main',
    ]);
    expect(result.stderr).not.toContain('git push failed');
  });

  it('retries a failed push with the same arguments until it succeeds', () => {
    const result = run(['push', '--tags', 'origin', 'HEAD:main'], 2);
    expect(result.status).toBe(0);
    expect(loggedCalls()).toEqual(new Array(3).fill('push --tags origin HEAD:main'));
    expect(result.stderr).toContain('git push failed (attempt 1 of 4)');
  });

  it('gives up after four attempts with the last failure', () => {
    const result = run(['push', 'origin'], 9);
    expect(result.status).toBe(1);
    expect(loggedCalls()).toHaveLength(4);
    expect(result.stderr).toContain('remote: fatal error in commit_refs');
  });

  it('refuses to run without REAL_GIT, rather than calling itself', () => {
    const result = spawnSync(wrapper, ['status'], {
      env: { ...process.env, REAL_GIT: '' },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('REAL_GIT');
  });
});

describe('release.yml semantic-release step', () => {
  const workflow = readFileSync(new URL('.github/workflows/release.yml', repoRoot), 'utf8');
  const step = workflow.slice(workflow.indexOf('pnpm exec semantic-release') - 200);

  it('puts the wrapper ahead of git on PATH and points it at the real git', () => {
    expect(step).toMatch(/REAL_GIT="\$\(command -v git\)"/);
    expect(step).toMatch(/PATH="\$GITHUB_WORKSPACE\/scripts\/git-retry:\$PATH"/);
  });
});
