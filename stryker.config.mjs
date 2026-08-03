import { existsSync } from 'node:fs';

// Mutation testing config. Rationale, scope choices and the TypeScript 7
// workaround are detailed in `docs/decisions/mutation-testing.md`.

// WORKAROUND (TypeScript 7): Stryker's sandbox runs a TSConfigPreprocessor that
// does a bare `import('typescript')` and calls `ts.parseConfigFileTextToJson`,
// absent from TS 7's experimental JS API — it throws before any mutant runs.
// Pointing `tsconfigFile` at a path that does not exist skips the preprocessor,
// which is safe here because it only rewrites relative `extends`/`references`
// paths and ours are package names. Why that holds, and the routes rejected:
// `docs/decisions/mutation-testing.md` (§3). Remove once stryker-js#6110 ships.
//
// The sentinel's absence is what makes this work, so assert it: creating the
// file would otherwise resurface the upstream crash as an unrelated-looking
// `ts.parseConfigFileTextToJson is not a function`.
const TSCONFIG_SENTINEL = 'tsconfig.stryker-absent.json';
if (existsSync(TSCONFIG_SENTINEL)) {
  throw new Error(
    `${TSCONFIG_SENTINEL} must not exist — it is a sentinel that skips Stryker's ` +
      'tsconfig preprocessor, which crashes on TypeScript 7. Delete the file, or see ' +
      'docs/decisions/mutation-testing.md (section 3) before changing this.',
  );
}

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',

  // Plugin auto-discovery globs `node_modules/@stryker-mutator/*`, which does
  // not resolve the runner under pnpm's symlinked layout. Declare it.
  plugins: ['@stryker-mutator/vitest-runner'],

  tsconfigFile: TSCONFIG_SENTINEL,

  // Scope: logic code, where a surviving mutant is a genuine test gap.
  // `src/tools/**` is deliberately out for now — its 151 `.describe()` calls
  // would yield one StringLiteral survivor each, drowning the signal.
  mutate: [
    'src/auth/**/*.ts',
    'src/client/**/*.ts',
    'src/routing/**/*.ts',
    'src/utils/**/*.ts',
    'src/config.ts',
  ],

  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },

  // Where `--incremental` keeps its baseline. Incremental mode is deliberately
  // NOT enabled by default: it diffs mutated sources and test files only, so a
  // dependency, config or Node change leaves verdicts replayed instead of
  // re-run — a correctness problem, not just a stale number. Opting in per
  // invocation keeps `pnpm test:mutation` trustworthy and makes the speed-up an
  // explicit choice. When to rebuild with `--force`:
  // `docs/decisions/mutation-testing.md` (§4).
  incrementalFile: 'reports/mutation/stryker-incremental.json',

  // A mutant that makes the code loop forever is detected by hanging the run.
  // The default budget is tight for the HTTP/OAuth suites, which stand up real
  // loopback servers; 20s keeps genuine hangs distinguishable from slow tests.
  timeoutMS: 20000,

  // Advisory only — `break` stays null so a mutation run never fails a build
  // on its own. A gate belongs on the diff's score, not this global baseline.
  thresholds: { high: 85, low: 70, break: null },
};
