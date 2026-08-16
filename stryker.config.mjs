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
  //
  // Two exclusions, same reason, both temporary. A file whose survivors are
  // mostly label strings does not merely score badly — it *booby-traps the PR
  // gate*, because editing any line carrying one fails CI for debt the author
  // did not create. Bringing a file in is therefore a decision to do its
  // assertion work first, tracked per file:
  //   - `src/tools/**`: its `.describe()` calls would each yield a StringLiteral
  //     survivor, drowning the signal.
  //   - `src/utils/formatting.ts`: 171 escaped mutants, 58 % of them label
  //     strings. #203 owns both the remaining work and the decision on how to
  //     treat those strings; delete the negation below when it lands.
  // Excluded from *mutation* only — its tests still run and still count for
  // coverage. `!` ordering matters: Stryker applies these as set/unset in
  // sequence (`project-reader`), and `scopeMatcher` in the gate mirrors that.
  mutate: [
    'src/auth/**/*.ts',
    'src/client/**/*.ts',
    'src/routing/**/*.ts',
    'src/utils/**/*.ts',
    '!src/utils/formatting.ts',
    'src/config.ts',
  ],

  // `json` is not CI-only: it is what `scripts/mutation-scope.mjs` reads to
  // judge a diff, so it belongs here rather than as a `--reporters` override
  // that has to restate the whole list. Both report paths are declared so the
  // script can read them from the config instead of hardcoding a default.
  //
  // `dashboard` is gated on the key because nothing else guards the upload: a
  // keyless CI run PUTs anyway and 401s. Only the baseline step gets the secret,
  // so only it publishes. Section 7 of the ADR.
  reporters: [
    'html',
    'json',
    'clear-text',
    'progress',
    ...(process.env.STRYKER_DASHBOARD_API_KEY ? ['dashboard'] : []),
  ],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },

  // `full` is also the default, but spelled out: it sends source snippets to a
  // third party, which is a decision. `project`/`version` stay unset — the
  // Actions provider derives them. Section 7 of the ADR.
  dashboard: { reportType: 'full' },

  // Score table yes, per-mutant dump no. Under `--incremental` the report is
  // project-wide, so `reportMutants` prints every survivor in the whole scope
  // (hundreds, each with its source snippet and covering tests) to stdout — and
  // the PR gate tees stdout into the job summary, which would bury the handful
  // of mutants the PR is actually being judged on under the repo's backlog. The
  // full per-mutant detail is in the uploaded HTML report.
  clearTextReporter: { reportMutants: false },

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
