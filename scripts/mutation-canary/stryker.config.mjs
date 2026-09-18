import base from '../../stryker.config.mjs';

// Stryker config for the mutation canary. Extends the repo's own config so the
// TypeScript 7 `tsconfigFile` sentinel and the explicit `plugins` entry cannot
// drift out of sync here. The overrides keep a canary failure unambiguous — its
// own tiny vitest project — and keep its output off the gate's report, its
// baseline and the dashboard.
// Background: docs/decisions/mutation-testing.md (§9).

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: ['scripts/mutation-canary/subject.ts'],
  vitest: { configFile: 'scripts/mutation-canary/vitest.config.ts' },

  // `ArrowFunction` empties both one-line arrows to the same `() => undefined`
  // text — two mutants the canary cannot tell apart, one of them static, which
  // Stryker runs without a test filter: the one path #297 left working, so its
  // verdict says nothing about the failure this exists to catch.
  mutator: { ...base.mutator, excludedMutations: ['ArrowFunction'] },
  reporters: ['json'],
  jsonReporter: { fileName: 'reports/mutation-canary/mutation.json' },
  // One fixture file, two mutants: extra workers only add startup cost.
  concurrency: 1,

  // Explicit although it is also the default: `base` names an `incrementalFile`
  // under `reports/mutation/`, which is the PR gate's baseline. A canary run
  // must never read a verdict from it, and above all never write one into it.
  incremental: false,
};
