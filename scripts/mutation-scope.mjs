#!/usr/bin/env node
// Diff-scoped mutation testing for the PR gate. Entry points: `pnpm
// test:mutation:diff <baseSha> <headSha> [...strykerFlags]` mutates only the
// lines the diff changed and fails if any of those mutants survived;
// `pnpm test:mutation:summary` prints the last report's score as Markdown.
//
// Why hand-written at all: StrykerJS has no git-aware scoping — nothing in its
// schema is `since`/`range`/`diff` (those are Stryker.NET, a different product).
// The open request for it is stryker-js#2843. So the two halves here
// are the whole job: turn a diff into `--mutate` line specs, and read the JSON
// report back. Both are small; what earns the file is that they are *tested*
// (tests/unit/mutation-scope.test.ts) — an off-by-one in the range arithmetic
// would silently stop guarding a line. Alternatives weighed, with the numbers:
// docs/decisions/mutation-testing.md ("Why a script and not a library").
//
// Why line ranges and not whole files: a PR that touches one line of a file
// whose existing tests are weak would otherwise be judged on every mutant in
// that file. The gate has to answer "did this PR's changes get tested", not "is
// this file's history good". Stryker takes `file:startLine-endLine` in
// `--mutate` natively, so the range is passed straight through.
//
// Why one command and not plan/run/gate as three: with `--incremental` Stryker
// emits the *full* project report, reusing verdicts for files outside the
// requested scope, so the gate has to filter by the exact ranges that were
// mutated. Holding those ranges in memory for the whole operation is what
// guarantees the verdict describes the run that just happened — three steps
// sharing a file on disk can be replayed out of order, and a stale scope beside
// a fresh report yields a confident verdict about the wrong lines.
//
// `--incremental` is deliberately NOT implied: pass it explicitly (CI does,
// because its cache key encodes every input incremental mode cannot diff).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, matchesGlob } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Statuses that mean "this change went unnoticed by every test". */
const ESCAPED = new Set(['Survived', 'NoCoverage']);

/**
 * Changed line ranges on the head side, per in-scope file, from a unified diff.
 * Pure: callers supply the diff text so `git` stays at the edge.
 *
 * Expects `--unified=0` (minimal hunks keep the ranges tight) and
 * `--diff-filter=d` (deletions have no head-side lines to mutate).
 */
export const changedRanges = (diffText, inScope) => {
  const ranges = [];
  let file = null;
  for (const line of diffText.split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header?.[1]) {
      file = inScope(header[1]) ? header[1] : null;
      continue;
    }
    if (!file) continue;
    // @@ -oldStart,oldCount +newStart,newCount @@
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk?.[1]) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue; // pure deletion at this position
    ranges.push({ file, start, end: start + count - 1 });
  }
  return ranges;
};

/** Stryker `--mutate` value for a set of ranges (comma-separated specs). */
export const specsFor = (ranges) => ranges.map((r) => `${r.file}:${r.start}-${r.end}`).join(',');

/**
 * Split the mutants that fall inside `ranges` into judged/escaped. Pure.
 *
 * A mutant counts as in-range when its span is *contained* in a changed range,
 * which is the same test Stryker applies when it decides what to instrument
 * (`locationIncluded` in the instrumenter's `syntax-helpers`, used by
 * `babel-transformer`). Containment, not overlap: under `--incremental` the
 * report also carries mutants Stryker chose NOT to instrument this run, replayed
 * from the baseline with their old verdict (`incremental-differ`, "old mutants
 * that didn't run this time around"). An overlap test would pull those in — a
 * multi-line mutant spanning lines 100-140 that survived on main, judged against
 * a PR that touched line 120 — and fail the PR on a stale verdict for code it
 * did not write, which the author cannot fix. Judging exactly what this run
 * mutated is the whole point of holding the ranges.
 *
 * Lines only, where Stryker's check is line+column: equivalent here because
 * `specsFor` emits whole-line ranges, which Stryker widens to column 0 through
 * MAX_SAFE_INTEGER (`project-reader`). Narrow a range to columns and this has to
 * grow columns too.
 */
export const escapedMutants = (ranges, report) => {
  const escaped = [];
  let judged = 0;
  for (const [file, fileReport] of Object.entries(report.files ?? {})) {
    for (const mutant of fileReport.mutants ?? []) {
      const { start, end } = mutant.location;
      const inRange = ranges.some(
        (r) => r.file === file && start.line >= r.start && end.line <= r.end,
      );
      if (!inRange) continue;
      judged += 1;
      if (ESCAPED.has(mutant.status)) escaped.push({ file, line: start.line, mutant });
    }
  }
  return { judged, escaped };
};

/** Tally every mutant in a report by status. Pure. */
export const tallyStatuses = (report) => {
  const counts = {};
  for (const fileReport of Object.values(report.files ?? {})) {
    for (const mutant of fileReport.mutants ?? []) {
      counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
    }
  }
  return counts;
};

/**
 * Predicate for "is this path in the `mutate` scope", with the same semantics
 * Stryker applies: patterns in order, a `!`-prefixed one *unsetting* what an
 * earlier one included (`project-reader`, `resolveFileDescriptions`). Pure.
 *
 * A naive `patterns.some(...)` would ignore the negations, and the consequence
 * is not a cosmetic mismatch: the gate passes its ranges to `--mutate`, and that
 * flag *replaces* the configured scope rather than intersecting with it. An
 * excluded file would be silently mutated and gated anyway — the exclusion
 * defeated in the one place it has to hold.
 */
export const scopeMatcher = (patterns) => (path) => {
  let included = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (matchesGlob(path, pattern.slice(1))) included = false;
    } else if (matchesGlob(path, pattern)) {
      included = true;
    }
  }
  return included;
};

/** Mutation score from a status tally, or null when there is nothing to score. */
export const scoreOf = (counts) => {
  const detected = (counts.Killed ?? 0) + (counts.Timeout ?? 0);
  const total = detected + (counts.Survived ?? 0) + (counts.NoCoverage ?? 0);
  return total === 0 ? null : (detected / total) * 100;
};

// --- edges: config, git, stryker -------------------------------------------

/**
 * The two facts this script needs from `stryker.config.mjs`, read from the
 * config itself rather than restated: which paths are in the mutate scope, and
 * where the JSON reporter writes.
 */
const loadConfig = async () => {
  const { default: config } = await import(pathToFileURL(join(repoRoot, 'stryker.config.mjs')));
  const mutate = config.mutate ?? [];
  if (mutate.length === 0) throw new Error('stryker.config.mjs declares no `mutate` patterns.');
  const reportPath = config.jsonReporter?.fileName;
  if (!reportPath) {
    throw new Error('stryker.config.mjs must set `jsonReporter.fileName` — the gate reads it.');
  }
  return { inScope: scopeMatcher(mutate), reportPath };
};

// `--src-prefix`/`--dst-prefix` are not decoration: a contributor with
// `diff.noprefix` or `diff.mnemonicPrefix` set gets `+++ path` or `+++ w/path`,
// which `changedRanges` cannot parse — the gate would then find no ranges and
// pass silently on a PR full of in-scope changes. Verified: with
// `diff.noprefix=true` the header comes out as `+++ src/utils/logger.ts`.
// `--no-ext-diff` keeps a configured external differ from replacing the unified
// format outright.
const gitDiff = (baseSha, headSha) =>
  execFileSync(
    'git',
    [
      'diff',
      '--unified=0',
      '--diff-filter=d',
      '--no-ext-diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      `${baseSha}...${headSha}`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );

const readReport = (reportPath) => {
  const absolute = join(repoRoot, reportPath);
  if (!existsSync(absolute)) {
    throw new Error(`${reportPath} not found — Stryker did not produce a JSON report.`);
  }
  return JSON.parse(readFileSync(absolute, 'utf8'));
};

// --- commands ---------------------------------------------------------------

const diffGate = async (baseSha, headSha, strykerFlags) => {
  const { inScope, reportPath } = await loadConfig();
  const ranges = changedRanges(gitDiff(baseSha, headSha), inScope);

  if (ranges.length === 0) {
    console.log('No changed lines inside the mutate scope — nothing to gate.');
    return;
  }

  const specs = specsFor(ranges);
  console.log(`Mutating the changed lines: ${specs}\n`);
  execFileSync('pnpm', ['exec', 'stryker', 'run', ...strykerFlags, '--mutate', specs], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  const { judged, escaped } = escapedMutants(ranges, readReport(reportPath));
  if (judged === 0) {
    // Not the same as "this change is safe", and worth saying so: Stryker only
    // mutates constructs *contained* in the range, so a one-line edit inside a
    // large multi-line expression can produce nothing to run. The gate is blind
    // there rather than reassuring — see the ADR, "What the gate cannot see".
    console.log(
      'Stryker produced no mutants inside the changed lines, so there is nothing to\n' +
        'gate. Note this is not a pass: an edit contained in a larger construct (a long\n' +
        'multi-line expression, say) can yield no mutant of its own. Review the change\n' +
        'on its merits.',
    );
    return;
  }

  console.log(
    `\nMutants in the changed lines: ${judged}. Killed: ${judged - escaped.length}. ` +
      `Escaped: ${escaped.length}.`,
  );
  if (escaped.length === 0) {
    console.log('Every mutant in the changed lines was detected.');
    return;
  }

  // stdout, not stderr: CI pipes this command's stdout into the job summary, and
  // the list of what escaped is the one thing the author has to act on. On
  // stderr it stayed in the raw log while only the count above reached them.
  console.log('\nThese mutants were introduced or touched by this PR and no test caught them:\n');
  for (const { file, line, mutant } of escaped) {
    console.log(`  ${file}:${line}  ${mutant.status}  ${mutant.mutatorName}`);
    console.log(`    replaced with: ${JSON.stringify(mutant.replacement ?? '')}`);
  }
  console.log(
    '\nEach one is a change a test should have noticed. Add or tighten an assertion —\n' +
      'never weaken one to go green. If a mutant is genuinely equivalent to the\n' +
      'original (unreachable defensive guard, say), say so in the code with\n' +
      '`// Stryker disable next-line <mutatorName>: <why>` so the reasoning is reviewable.\n' +
      'Background: docs/decisions/mutation-testing.md\n',
  );
  process.exitCode = 1;
};

const summary = async () => {
  const { reportPath } = await loadConfig();
  const counts = tallyStatuses(readReport(reportPath));
  const score = scoreOf(counts);
  const lines = ['| Metric | Value |', '| --- | --- |'];
  lines.push(`| Mutation score | ${score === null ? 'n/a' : `${score.toFixed(2)}%`} |`);
  for (const status of Object.keys(counts).sort()) lines.push(`| ${status} | ${counts[status]} |`);
  console.log(lines.join('\n'));
};

const USAGE =
  'usage: pnpm test:mutation:diff <baseSha> <headSha> [...strykerFlags]\n' +
  '       pnpm test:mutation:summary';

// Only dispatch when run as a program — the exports above are unit-tested.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'diff') {
    const [baseSha, headSha, ...strykerFlags] = args;
    // A leading `-` means a flag landed where a commit-ish belongs; passing it
    // through would make `git diff` print its own usage and bury the cause.
    if (!baseSha || !headSha || baseSha.startsWith('-') || headSha.startsWith('-')) {
      console.error(`${USAGE}\n\n<baseSha> and <headSha> are positional commit-ishes, not flags.`);
      process.exit(2);
    }
    await diffGate(baseSha, headSha, strykerFlags);
  } else if (command === 'summary') {
    await summary();
  } else {
    console.error(USAGE);
    process.exit(2);
  }
}
