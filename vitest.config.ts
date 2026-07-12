import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      // index.ts/stdio.ts are thin runtime bootstraps; types.ts is type-only.
      // dev/watch.ts is a dev-only bootstrap (fs.watch + stdio wiring); its
      // reconciliation logic (createReloadableServer/reload/registerToolset) is
      // covered end-to-end by tests/integration/watch-reload.test.ts.
      exclude: ['src/index.ts', 'src/transports/stdio.ts', 'src/types.ts', 'src/dev/watch.ts'],
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
