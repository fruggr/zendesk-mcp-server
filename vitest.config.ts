import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Every suite lives under `tests/`, so say that instead of relying on
    // Vitest's repo-wide default glob. The default collects any *copy* of the
    // tree too: Stryker leaves a full project clone (tests included) in
    // `.stryker-tmp/sandbox-*`, so a plain `pnpm test` was picking up every
    // suite three times over, against *mutated* sources, reporting failures
    // that do not exist here. Same hazard for a git worktree, an unpacked
    // tarball or a vendored checkout inside the repo — an allowlist closes all
    // of them at once, where excluding `.stryker-tmp` would close only one.
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      // index.ts/stdio.ts are thin runtime bootstraps; types.ts is type-only.
      // dev/reload.ts stays included: its reload machinery is tested; only the
      // startDevServer stdio bootstrap inside it is `v8 ignore`d.
      exclude: ['src/index.ts', 'src/transports/stdio.ts', 'src/types.ts'],
      // Quality gate: fail the run if coverage drops below these baselines.
      // Ratchet these up as coverage improves; never lower them silently.
      thresholds: {
        statements: 94,
        branches: 77,
        functions: 98,
        lines: 95,
      },
    },
  },
});
