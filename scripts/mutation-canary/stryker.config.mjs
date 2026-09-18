import base from '../../stryker.config.mjs';

// Stryker config for the mutation canary. Extends the repo's own config rather
// than restating it, so the TypeScript 7 `tsconfigFile` sentinel and the
// explicit `plugins` entry — both load-bearing workarounds documented in
// `docs/decisions/mutation-testing.md` — cannot drift out of sync here.
//
// Everything overridden below is overridden to keep the canary's failure
// unambiguous: its own tiny vitest project, its own report path (the gate reads
// the repo's), and `json` alone as the reporter — so a canary run never
// publishes to the dashboard, and the inherited `htmlReporter` path pointing
// into `reports/mutation/` is never written to.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: ['scripts/mutation-canary/subject.ts'],
  vitest: { configFile: 'scripts/mutation-canary/vitest.config.ts' },

  // `ArrowFunction` empties a whole arrow body, which the fixture's two
  // one-line arrows both yield as the same `() => undefined` text — two mutants
  // the canary could not tell apart, one of them static (so Stryker runs it
  // without a test filter, the one path #297 left working, which makes its
  // verdict silent about the failure this exists to catch). Excluding it leaves
  // exactly one `ArithmeticOperator` mutant per function, each identifiable by
  // its replacement alone.
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
