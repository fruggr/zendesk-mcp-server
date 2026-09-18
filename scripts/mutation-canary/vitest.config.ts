import { defineConfig } from 'vitest/config';

// The canary's own vitest project: the fixture test and nothing else. Kept
// apart from the repo's `vitest.config.ts` so the canary run stays a few
// hundred milliseconds, and so a failure has exactly one possible cause —
// no setup file, no MSW, no coverage thresholds to trip over.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/mutation-canary/*.test.ts'],
  },
});
