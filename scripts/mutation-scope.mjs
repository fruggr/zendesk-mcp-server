#!/usr/bin/env node
// Diff-scoped mutation testing for the PR gate.
//
// Two commands, sharing one definition of "the lines this PR changed":
//
//   plan <baseSha> <headSha>   Write the changed line ranges to a plan file and
//                             print Stryker `--mutate` specs on stdout (empty if
//                             the diff touches nothing in the mutate scope).
//   gate                      Read the plan and Stryker's JSON report; fail if a
//                             mutant inside those ranges survived.
//
// Why line ranges and not whole files: a PR that touches one line of a file
// whose existing tests are weak would otherwise be judged on every mutant in
// that file. The gate has to answer "did this PR's changes get tested", not
// "is this file's history good". Stryker supports `file:startLine-endLine`
// natively (`--mutate`), so the range is passed straight through.
//
// Why the gate reads a plan file instead of recomputing: with `--incremental`
// Stryker emits the *full* project report, reusing verdicts for files outside
// the requested scope. Filtering by the exact ranges that were planned is what
// keeps the gate about this PR.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLAN_PATH = 'reports/mutation/diff-scope.json';
const REPORT_PATH = 'reports/mutation/mutation.json';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Turn one `mutate` glob from stryker.config.mjs into a predicate. Only the two
 * shapes the config actually uses are recognised; anything else throws rather
 * than being silently mis-scoped, since a wrong scope here means the gate
 * quietly stops guarding part of the tree.
 */
const patternToPredicate = (pattern) => {
  if (pattern.endsWith('/**/*.ts')) {
    const prefix = pattern.slice(0, -'**/*.ts'.length);
    return (path) => path.startsWith(prefix) && path.endsWith('.ts');
  }
  if (!pattern.includes('*')) {
    return (path) => path === pattern;
  }
  throw new Error(
    `Unsupported mutate pattern ${JSON.stringify(pattern)} in stryker.config.mjs. ` +
      'scripts/mutation-scope.mjs understands "<dir>/**/*.ts" and exact paths only — ' +
      'teach it the new shape rather than letting the PR gate mis-scope.',
  );
};

const loadScopePredicate = async () => {
  const { default: config } = await import(pathToFileURL(join(repoRoot, 'stryker.config.mjs')));
  const predicates = (config.mutate ?? []).map(patternToPredicate);
  if (predicates.length === 0) throw new Error('stryker.config.mjs declares no `mutate` patterns.');
  return (path) => predicates.some((matches) => matches(path));
};

/**
 * Changed line ranges on the head side, per file. `--unified=0` keeps hunks
 * minimal so the ranges stay tight; `--diff-filter=d` drops deletions, which
 * have no head-side lines to mutate.
 */
const changedRanges = (baseSha, headSha, inScope) => {
  const diff = execFileSync(
    'git',
    ['diff', '--unified=0', '--diff-filter=d', `${baseSha}...${headSha}`],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  const ranges = [];
  let file = null;
  for (const line of diff.split('\n')) {
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

const writePlan = (ranges) => {
  mkdirSync(join(repoRoot, dirname(PLAN_PATH)), { recursive: true });
  writeFileSync(join(repoRoot, PLAN_PATH), `${JSON.stringify({ ranges }, null, 2)}\n`);
};

const plan = async (baseSha, headSha) => {
  const ranges = changedRanges(baseSha, headSha, await loadScopePredicate());
  writePlan(ranges);
  // One spec per range; Stryker accepts a comma-separated list.
  process.stdout.write(ranges.map((r) => `${r.file}:${r.start}-${r.end}`).join(','));
};

const gate = () => {
  const { ranges } = JSON.parse(readFileSync(join(repoRoot, PLAN_PATH), 'utf8'));
  const report = JSON.parse(readFileSync(join(repoRoot, REPORT_PATH), 'utf8'));

  const byFile = new Map();
  for (const range of ranges) {
    if (!byFile.has(range.file)) byFile.set(range.file, []);
    byFile.get(range.file).push(range);
  }

  const escaped = [];
  let judged = 0;
  for (const [file, fileReport] of Object.entries(report.files ?? {})) {
    const fileRanges = byFile.get(file);
    if (!fileRanges) continue;
    for (const mutant of fileReport.mutants ?? []) {
      const { start, end } = mutant.location;
      const touched = fileRanges.some((r) => start.line <= r.end && end.line >= r.start);
      if (!touched) continue;
      judged += 1;
      if (mutant.status === 'Survived' || mutant.status === 'NoCoverage') {
        escaped.push({ file, line: start.line, mutant });
      }
    }
  }

  if (judged === 0) {
    console.log('No mutants in the changed lines — nothing to gate.');
    return;
  }

  const killed = judged - escaped.length;
  console.log(
    `Mutants in the changed lines: ${judged}. Killed: ${killed}. Escaped: ${escaped.length}.`,
  );

  if (escaped.length === 0) {
    console.log('Every mutant in the changed lines was detected.');
    return;
  }

  console.error('\nThese mutants were introduced or touched by this PR and no test caught them:\n');
  for (const { file, line, mutant } of escaped) {
    console.error(`  ${file}:${line}  ${mutant.status}  ${mutant.mutatorName}`);
    console.error(`    replaced with: ${JSON.stringify(mutant.replacement ?? '')}`);
  }
  console.error(
    '\nEach one is a change a test should have noticed. Add or tighten an assertion —\n' +
      'never weaken one to go green. If a mutant is genuinely equivalent to the\n' +
      'original (unreachable defensive guard, say), say so in the code with\n' +
      '`// Stryker disable next-line <mutatorName>: <why>` so the reasoning is reviewable.\n' +
      'Background: docs/decisions/mutation-testing.md\n',
  );
  process.exitCode = 1;
};

const [command, ...args] = process.argv.slice(2);
if (command === 'plan') {
  const [baseSha, headSha] = args;
  if (!baseSha || !headSha) {
    console.error('usage: mutation-scope.mjs plan <baseSha> <headSha>');
    process.exit(2);
  }
  await plan(baseSha, headSha);
} else if (command === 'gate') {
  gate();
} else {
  console.error('usage: mutation-scope.mjs plan <baseSha> <headSha> | mutation-scope.mjs gate');
  process.exit(2);
}
