#!/usr/bin/env node
/**
 * Benchmark the lint/format toolchain candidates evaluated in
 * `docs/decisions/lint-tooling.md`.
 *
 * The evaluation numbers in that document come from an x86-64 container. The
 * open question is whether the ratios hold on Android/Termux/PRoot, where the
 * `PostToolUse` hook actually hurts — so this script exists to be re-run there.
 *
 *   node scripts/bench-lint-tooling.mjs            # default: 9 runs, 2 warm-ups
 *   RUNS=15 node scripts/bench-lint-tooling.mjs    # more samples, slower
 *
 * The Oxc binaries are optional and normally absent — those rows skip
 * themselves. The decision record explains why they are not dependencies.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hrtime } from 'node:process';

/** An empty `samples` crashes the median/min/max formatting, so reject bad input up front. */
const readCount = (name, raw, minimum) => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    console.error(`${name} must be an integer >= ${minimum}, got ${JSON.stringify(raw)}.`);
    process.exit(1);
  }
  return value;
};

const RUNS = readCount('RUNS', process.env['RUNS'] ?? 9, 1);
const WARMUPS = readCount('WARMUPS', process.env['WARMUPS'] ?? 2, 0);

const BIOME = './node_modules/.bin/biome';
const OXLINT = './node_modules/.bin/oxlint';
const OXFMT = './node_modules/.bin/oxfmt';

// A representative single file: the hook only ever lints what was just edited.
const ONE_FILE = 'src/tools/tickets.ts';
const BIOME_PATHS = 'src/ tests/ scripts/';
const OX_PATHS = 'src tests scripts';

// Stand-in for a pre-commit hook's staged set: a handful of files, not the tree.
const STAGED_FILE_LIST = [
  'src/tools/tickets.ts',
  'src/tools/help-center.ts',
  'src/utils/formatting.ts',
  'src/utils/pagination.ts',
  'src/auth/token-store.ts',
];
const STAGED_FILES = STAGED_FILE_LIST.join(' ');

/**
 * Several scenarios pass `--write`, because that is what the hooks they model
 * actually run and dropping it would understate their cost. They really do write
 * to the tree, so every file they can touch is snapshotted below and restored
 * afterwards — including on Ctrl-C.
 */
const scenarios = [
  // --- Stage 1: PostToolUse. Lint only, and `--skip=types` is the whole story:
  //     the two `types`-domain rules in biome.json force a project-wide type
  //     inference pass that dominates every Biome invocation.
  ['1 edit    biome check --write  (today)', BIOME, `${BIOME} check --write ${ONE_FILE}`],
  ['1 edit    biome lint           (no skip)', BIOME, `${BIOME} lint ${ONE_FILE}`],
  ['1 edit    biome lint --skip=types', BIOME, `${BIOME} lint --skip=types ${ONE_FILE}`],
  [
    '1 edit    biome lint --write --skip=types  (PROPOSED)',
    BIOME,
    `${BIOME} lint --write --skip=types --no-errors-on-unmatched ${ONE_FILE}`,
  ],
  ['1 edit    oxlint               (reference)', OXLINT, `${OXLINT} ${ONE_FILE}`],

  // --- Stage 2: pre-commit. The same command `lefthook.yml` runs, staged scope.
  [
    'precommit biome check --write --error-on-warnings',
    BIOME,
    `${BIOME} check --write --error-on-warnings --no-errors-on-unmatched ${STAGED_FILES}`,
  ],

  // --- Stage 3: CI. The same command again, project scope.
  [
    'ci        biome check --error-on-warnings  (pnpm check)',
    BIOME,
    `${BIOME} check --error-on-warnings ${BIOME_PATHS}`,
  ],
  [
    'ci        biome check --skip=types  (cost of the 2 type rules)',
    BIOME,
    `${BIOME} check --skip=types --error-on-warnings ${BIOME_PATHS}`,
  ],
  ['ci        oxlint               (reference)', OXLINT, `${OXLINT} ${OX_PATHS}`],
  ['ci        oxlint --type-aware  (reference)', OXLINT, `${OXLINT} --type-aware ${OX_PATHS}`],

  // --- Reference: what is NOT adopted, kept so the choice stays checkable.
  ['ref       biome format (no import sorting)', BIOME, `${BIOME} format ${BIOME_PATHS}`],
  ['ref       oxfmt --check', OXFMT, `${OXFMT} --check ${OX_PATHS}`],
];

/**
 * Biome exits 0 with findings, and a config that resolves outside the repo
 * silently matches nothing — so a scenario that checked zero files would report
 * an excellent time for doing nothing. That trap cost real debugging during the
 * evaluation (see the `--config-path` note in the decision record), so prove
 * each Biome scenario touches at least one file before timing it.
 *
 * Run once with output captured, separately from the timed loop, which keeps
 * `stdio: 'ignore'` so pipe handling never lands in a measurement.
 */
const assertChecksFiles = (label, command) => {
  let output;
  try {
    output = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // Non-zero exit is expected whenever findings remain; the summary is still printed.
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  const checked = output.match(/Checked (\d+) file/);
  if (!checked) {
    console.error(`\n${label}: no "Checked N files" line in the output — cannot validate.`);
    process.exit(1);
  }
  if (checked[1] === '0') {
    console.error(`\n${label}: checked 0 files. Fix the paths or config before benchmarking.`);
    process.exit(1);
  }
};

/**
 * Wall-clock median over RUNS samples. Exit codes are ignored on purpose: a
 * linter that reports findings exits non-zero, and we are timing the work, not
 * asserting the tree is clean.
 */
const measure = (command) => {
  for (let i = 0; i < WARMUPS; i++) {
    try {
      execSync(command, { stdio: 'ignore' });
    } catch {
      // Findings or a non-zero exit are expected; the timing is what matters.
    }
  }
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    const started = hrtime.bigint();
    try {
      execSync(command, { stdio: 'ignore' });
    } catch {
      // See above.
    }
    samples.push(Number(hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return {
    median: samples[Math.floor(samples.length / 2)],
    min: samples[0],
    max: samples.at(-1),
  };
};

const ms = (value) => `${value.toFixed(1)}ms`.padStart(10);

const available = scenarios.filter(([, binary]) => existsSync(binary));
const skipped = scenarios.filter(([, binary]) => !existsSync(binary));

if (available.length === 0) {
  console.error('No lint toolchain found under node_modules/.bin — run `pnpm install` first.');
  process.exit(1);
}

console.log(`${RUNS} runs per scenario, ${WARMUPS} warm-ups discarded, median reported.\n`);

const width = Math.max(...available.map(([label]) => label.length));
console.log(
  `${'scenario'.padEnd(width)}${'median'.padStart(10)}${'min'.padStart(10)}${'max'.padStart(10)}`,
);

// The `--write` scenarios modify these; put them back whatever happens.
const writeTargets = [...new Set([ONE_FILE, ...STAGED_FILE_LIST])];
const pristine = new Map(writeTargets.map((file) => [file, readFileSync(file)]));
const restoreWriteTargets = () => {
  for (const [file, contents] of pristine) {
    writeFileSync(file, contents);
  }
};
process.on('SIGINT', () => {
  restoreWriteTargets();
  process.exit(130);
});

const results = [];
try {
  for (const [label, binary, command] of available) {
    if (binary === BIOME) {
      assertChecksFiles(label, command);
    }
    const { median, min, max } = measure(command);
    console.log(`${label.padEnd(width)}${ms(median)}${ms(min)}${ms(max)}`);
    results.push({ label, median: +median.toFixed(1), min: +min.toFixed(1), max: +max.toFixed(1) });
  }
} finally {
  restoreWriteTargets();
}

for (const [label] of skipped) {
  console.log(`${label.padEnd(width)}${'(skipped)'.padStart(10)}`);
}

console.log(`\nJSON: ${JSON.stringify(results)}`);
