import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Stryker copies the whole project into `.stryker-tmp/sandbox-*` for each
    // of its runners. Those copies contain a full `tests/` tree, so without
    // this a plain `pnpm test` collects every suite two or three times over —
    // against *mutated* sources — and reports failures that do not exist in the
    // working tree. Not covered by Vitest's defaults; keep it.
    exclude: [...configDefaults.exclude, '**/.stryker-tmp/**'],
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
