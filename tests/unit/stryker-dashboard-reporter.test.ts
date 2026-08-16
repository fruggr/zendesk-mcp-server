import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The `dashboard` reporter publishes to a third party, and whether it is active
// is decided by an environment variable rather than by the reporter list being
// read literally. That indirection is the whole safety property — the workflow
// gives `STRYKER_DASHBOARD_API_KEY` to the baseline step only, so a PR run
// (fork included) has no key and cannot publish a diff-scoped report over the
// trend. Nothing else in the repo would fail if someone "simplified" the
// conditional into an unconditional entry, so it is pinned here.
// Reasoning: `docs/decisions/mutation-testing.md` (section 7).

const CONFIG_PATH = join(fileURLToPath(new URL('../../', import.meta.url)), 'stryker.config.mjs');

/**
 * Re-imports the config with a fresh module registry, so the env var is read
 * again instead of served from the first import's cached evaluation.
 */
async function loadConfig(): Promise<{
  reporters: string[];
  dashboard?: { reportType?: string; project?: string; version?: string; module?: string };
}> {
  vi.resetModules();
  const { default: config } = await import(pathToFileURL(CONFIG_PATH).href);
  return config;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('stryker.config.mjs — dashboard reporter gating', () => {
  it('leaves the reporter off when no API key is set', async () => {
    vi.stubEnv('STRYKER_DASHBOARD_API_KEY', undefined);

    expect((await loadConfig()).reporters).toEqual(['html', 'json', 'clear-text', 'progress']);
  });

  it('leaves the reporter off when the key is empty, as an unset GitHub secret expands', async () => {
    // `${{ secrets.X }}` on a repo without the secret is '', not absent — the
    // state the workflow is in until someone enables the project.
    vi.stubEnv('STRYKER_DASHBOARD_API_KEY', '');

    expect((await loadConfig()).reporters).toEqual(['html', 'json', 'clear-text', 'progress']);
  });

  it('appends the reporter, keeping the others, once a key is present', async () => {
    vi.stubEnv('STRYKER_DASHBOARD_API_KEY', 'dashboard-key');

    expect((await loadConfig()).reporters).toEqual([
      'html',
      'json',
      'clear-text',
      'progress',
      'dashboard',
    ]);
  });

  it('publishes a full report, and leaves project/version to CI auto-detection', async () => {
    vi.stubEnv('STRYKER_DASHBOARD_API_KEY', 'dashboard-key');
    const { dashboard } = await loadConfig();

    // `full` is a deliberate choice (source snippets leave the repo), not an
    // inherited default; `mutationScore` would silently drop the hosted report.
    expect(dashboard?.reportType).toBe('full');
    // Unset on purpose: GithubActionsCIProvider derives these from
    // GITHUB_REPOSITORY / GITHUB_REF. Pinning either here would freeze the
    // trend onto one branch. `module` stays out — see the ADR.
    expect(dashboard?.project).toBeUndefined();
    expect(dashboard?.version).toBeUndefined();
    expect(dashboard?.module).toBeUndefined();
  });
});
