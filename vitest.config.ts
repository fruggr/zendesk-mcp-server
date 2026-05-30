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
      exclude: ['src/index.ts', 'src/transports/stdio.ts', 'src/types.ts'],
      // Quality gate: fail the run if coverage drops below these baselines.
      // Ratchet these up as coverage improves; never lower them silently.
      thresholds: {
        statements: 90,
        branches: 75,
        functions: 90,
        lines: 90,
      },
    },
  },
});
