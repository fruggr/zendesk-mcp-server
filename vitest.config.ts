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
      // dev/reload.ts is a dev-only module; its startDevServer bootstrap wires
      // the reload tool to a real stdio transport. The reconciliation and the
      // reload tool (createReloadableServer/reload/registerReloadTool) are
      // covered end-to-end by tests/integration/dev-reload.test.ts.
      exclude: ['src/index.ts', 'src/transports/stdio.ts', 'src/types.ts', 'src/dev/reload.ts'],
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
