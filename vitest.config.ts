import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // An allowlist, not the default repo-wide glob: the default also collects
    // any *copy* of the tree (Stryker's `.stryker-tmp` sandbox, a worktree, an
    // unpacked tarball), which runs every suite twice over against mutated
    // sources.
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
