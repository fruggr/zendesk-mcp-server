// Mutation testing config. Rationale, scope choices and the TypeScript 7
// workaround below are detailed in `docs/decisions/mutation-testing.md`.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',

  // Plugin auto-discovery globs `node_modules/@stryker-mutator/*`, which does
  // not resolve the runner under pnpm's symlinked layout. Declare it.
  plugins: ['@stryker-mutator/vitest-runner'],

  // WORKAROUND (TypeScript 7): Stryker's sandbox runs a TSConfigPreprocessor
  // that does a bare `import('typescript')` and calls
  // `ts.parseConfigFileTextToJson`, absent from TS 7's experimental JS API —
  // it throws before any mutant runs. The preprocessor only rewrites relative
  // `extends`/`references` paths that would fall outside the sandbox; our
  // tsconfig extends package names (`@tsconfig/node20`), so it has nothing to
  // rewrite and pointing it at a file that does not exist skips it entirely.
  // Remove once stryker-js#6110 ships TS 7 support.
  tsconfigFile: 'tsconfig.stryker-absent.json',

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
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',

  // The vitest runner only supports `threads: true`; it sets the pool itself,
  // overriding the project default (`forks`). The suite passes under both.
  vitest: { configFile: 'vitest.config.ts' },

  // A mutant that makes the code loop forever is detected by hanging the run.
  // The default budget is tight for the HTTP/OAuth suites, which stand up real
  // loopback servers; 20s keeps genuine hangs distinguishable from slow tests.
  timeoutMS: 20000,

  // Advisory only — `break` stays null so a mutation run never fails a build
  // on its own. The PR gate scores the diff, not this global baseline.
  thresholds: { high: 85, low: 70, break: null },
};
