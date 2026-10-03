import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

// The suite that runs what ships (tests/bundle/): kept out of `pnpm test` because
// it needs a fresh `pnpm build`, and its child processes are slower than the
// in-process harnesses. Spread rather than mergeConfig, which would concatenate
// `include` with the base suite and keep its `exclude`.
export default defineConfig({
  test: {
    ...base.test,
    include: ['tests/bundle/**/*.test.ts'],
    exclude: [],
    coverage: { enabled: false },
    testTimeout: 60_000,
  },
});
