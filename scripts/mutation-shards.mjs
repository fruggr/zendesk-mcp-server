#!/usr/bin/env node
// Splits the full mutation baseline into shards of chunks that each finish
// inside one CI job, runs one shard, and merges them back. Why, and how the
// pieces fit: docs/decisions/mutation-testing.md, section 4. Used by mutation.yml:
//
//   node scripts/mutation-shards.mjs plan --shards N --chunks K [--baseline <file>]
//   node scripts/mutation-shards.mjs run-shard     (chunks in $SHARD_CHUNKS, JSON)
//   node scripts/mutation-shards.mjs merge --out <file> [--fallback <file>] <shard dir>...
//   node scripts/mutation-shards.mjs drift [--budget-minutes 75] [--history <in>] [--history-out <out>]
//                                          [--summary <file>] <shard dir>...

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './mutation-scope.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What `run-shard` leaves for the merge: the chunks it finished, and a copy of
 * Stryker's report taken after each one, so a kill in the middle of the next
 * chunk cannot spoil what was finished. Both are replaced by an atomic rename,
 * report first: a kill between the two leaves `done.json` behind the report,
 * never ahead of it.
 */
export const SHARD_DIR = 'reports/shard';

const replaceAtomically = (dest, write) => {
  const tmp = `${dest}.tmp`;
  write(tmp);
  renameSync(tmp, dest);
};

// --- pure core ----------------------------------------------------------------

/**
 * What a file costs to mutate: the tests its mutants actually ran. A static
 * mutant runs the whole suite, which is what makes a file expensive, and this
 * is the one measure that sees it. Ignored mutants are never run.
 */
export const costOfFile = (entry) =>
  (entry?.mutants ?? []).reduce((sum, m) => {
    if (m.status === 'Ignored') return sum;
    return sum + Math.max(1, m.testsCompleted ?? m.coveredBy?.length ?? 1);
  }, 0);

/**
 * Cost per path: from the baseline where it has the file, otherwise its size
 * scaled by the baseline's cost per byte (raw size on a cold run, where only the
 * proportions between files matter).
 */
export const estimateCosts = (paths, baselineFiles, sizes) => {
  const known = paths.filter((p) => baselineFiles[p]);
  const knownCost = known.reduce((s, p) => s + costOfFile(baselineFiles[p]), 0);
  const knownSize = known.reduce((s, p) => s + (sizes[p] ?? 0), 0);
  const perByte = knownCost > 0 && knownSize > 0 ? knownCost / knownSize : 1;
  return new Map(
    paths.map((p) => [
      p,
      baselineFiles[p] ? costOfFile(baselineFiles[p]) : (sizes[p] ?? 0) * perByte,
    ]),
  );
};

/**
 * Longest-processing-time first: heaviest item onto the lightest bin. Ties go
 * by path and by bin index, so the same inputs always give the same plan.
 */
export const balance = (items, count) => {
  const bins = Array.from({ length: count }, () => ({ paths: [], cost: 0 }));
  const sorted = [...items].sort(
    ([pa, ca], [pb, cb]) => cb - ca || Number(pa > pb) - Number(pa < pb),
  );
  for (const [path, cost] of sorted) {
    const lightest = bins.reduce((best, bin) => (bin.cost < best.cost ? bin : best), bins[0]);
    lightest.paths.push(path);
    lightest.cost += cost;
  }
  return bins.filter((bin) => bin.paths.length > 0);
};

/**
 * Shards for the matrix, each split into chunks Stryker runs one after another:
 * a shard killed mid-way keeps the chunks it finished.
 */
export const planShards = (costs, { shards, chunksPerShard }) =>
  balance([...costs], shards).map((shard, index) => ({
    index,
    cost: shard.cost,
    chunks: balance(
      shard.paths.map((p) => [p, costs.get(p)]),
      chunksPerShard,
    ).map((chunk) => chunk.paths),
  }));

/** Stryker's own identity for a test across runs (`testToIdentifyingKey`, incremental-differ). */
const testKey = (file, test) => {
  const start = test.startPosition ?? test.location?.start ?? { line: 0, column: 0 };
  return `${file}@${start.line}:${start.column}\n${test.name}`;
};

/**
 * One baseline from the shards.
 *
 * Files, by precedence: whatever the shards reused, then the restored baseline,
 * then each file from the shard that finished it (a killed shard's file keeps its
 * older copy).
 *
 * Tests need more than a union. A mutant names its tests by id (`coveredBy`,
 * `killedBy`), and ids are numbered per run, so the same id means different
 * tests in two shards. Every test is renumbered on its identity, and each kept
 * file's mutants are rewritten through the table of the report they came from;
 * otherwise Stryker reads the coverage as changed and re-runs the mutant.
 */
export const mergeReports = ({ fallbacks, shards }) => {
  const sources = [
    ...shards.map((s) => ({ report: s.report, done: [] })),
    ...fallbacks.map((report) => ({ report, done: [] })),
    ...shards.map((s) => ({ report: s.report, done: s.done, finishing: true })),
  ];
  if (sources.length === 0) return null;

  const newIds = new Map();
  const testFiles = {};
  const keyTables = new Map();
  const testFileOf = new Map();
  // Tests: restored first, shards over it, so this commit's sources win.
  for (const report of [...fallbacks, ...shards.map((s) => s.report)]) {
    const table = new Map();
    for (const [file, entry] of Object.entries(report.testFiles ?? {})) {
      const merged = testFiles[file] ?? { tests: [] };
      if (entry.source !== undefined) merged.source = entry.source;
      for (const test of entry.tests ?? []) {
        const key = testKey(file, test);
        if (!newIds.has(key)) {
          newIds.set(key, String(newIds.size));
          merged.tests.push({ ...test, id: newIds.get(key) });
        }
        table.set(test.id, newIds.get(key));
        testFileOf.set(newIds.get(key), file);
      }
      testFiles[file] = merged;
    }
    keyTables.set(report, table);
  }

  // A verdict kept from a report whose copy of a test file differs from the
  // merged one was computed against another version of that test. Stryker diffs
  // test sources against the merged copy only, so it would reuse the verdict:
  // drop the mutant instead, and the next pass runs it again.
  // A test file the report never saw counts as changed too: a static mutant (run
  // by every test) kept from it never ran against that file.
  const staleFiles = (report) =>
    new Set(
      Object.keys(testFiles).filter(
        (file) => report.testFiles?.[file]?.source !== testFiles[file].source,
      ),
    );
  const remap = (ids, table) => ids?.map((id) => table.get(id)).filter((id) => id !== undefined);
  const files = {};
  for (const { report, done, finishing } of sources) {
    const table = keyTables.get(report) ?? new Map();
    const stale = finishing ? new Set() : staleFiles(report);
    for (const [path, entry] of Object.entries(report.files ?? {})) {
      if (finishing && !done.includes(path)) continue;
      const mutants = (entry.mutants ?? [])
        .map((m) => ({
          ...m,
          ...(m.coveredBy && { coveredBy: remap(m.coveredBy, table) }),
          ...(m.killedBy && { killedBy: remap(m.killedBy, table) }),
        }))
        .filter((m) => {
          if (stale.size === 0) return true;
          if (m.static) return false;
          return ![...(m.coveredBy ?? []), ...(m.killedBy ?? [])].some((id) =>
            stale.has(testFileOf.get(id)),
          );
        });
      files[path] = { ...entry, mutants };
    }
  }
  return { ...sources.at(-1).report, files, testFiles };
};

/**
 * Whether the plan still fits: a shard close to its budget, or one far slower
 * than the others, warns before a shard is killed. Thresholds: 60 % of the
 * budget, and 1.5 times the mean once the slowest passes 20 % of the budget:
 * below that (a warm run of a few minutes) an imbalance costs nothing.
 * ADR section 4.
 */
export const driftReport = ({
  shards,
  budgetSeconds,
  warnShare = 0.6,
  imbalanceLimit = 1.5,
  imbalanceFloor = 0.2,
}) => {
  const timed = shards.filter((s) => typeof s.seconds === 'number');
  const slowest = timed.length ? Math.max(...timed.map((s) => s.seconds)) : null;
  const mean = timed.length ? timed.reduce((sum, s) => sum + s.seconds, 0) / timed.length : null;
  const imbalance = slowest !== null && mean > 0 ? slowest / mean : null;
  const minutes = (seconds) => `${Math.round(seconds / 60)} min`;
  const warnings = [
    ...shards
      .filter((s) => typeof s.seconds !== 'number')
      .map((s) => `Shard ${s.index} reported no timing (killed or failed early).`),
    ...timed
      .filter((s) => s.cutOff)
      .map(
        (s) =>
          `Shard ${s.index} was cut off before finishing; ${minutes(s.seconds)} is a lower bound.`,
      ),
    ...timed
      .filter((s) => s.seconds / budgetSeconds > warnShare)
      .map(
        (s) =>
          `Shard ${s.index} took ${minutes(s.seconds)}, ${Math.round((s.seconds / budgetSeconds) * 100)} % of the ${minutes(budgetSeconds)} budget.`,
      ),
    ...(imbalance !== null && imbalance > imbalanceLimit && slowest > budgetSeconds * imbalanceFloor
      ? [
          `Shards are unbalanced: the slowest took ${imbalance.toFixed(2)} times the mean (${minutes(slowest)} against ${minutes(mean)}).`,
        ]
      : []),
  ];
  return { shards, budgetSeconds, slowest, mean, imbalance, warnings };
};

const duration = (seconds) => `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;

/**
 * One row per *planned* shard, so a shard that left no timing (killed in its
 * first chunk, or never started) still shows. A shard stopped inside a chunk
 * (`current` left behind) or between two (fewer chunks recorded than planned)
 * is cut off: its time so far is only a lower bound.
 */
export const shardTimings = (planned, timings) => {
  const byIndex = new Map(timings.map((t) => [t.index, t]));
  return planned.map(({ index, cost, chunks }) => {
    const t = byIndex.get(index);
    const recorded = t?.chunks?.length ?? 0;
    return {
      index,
      cost,
      seconds: recorded ? t.seconds : null,
      cutOff: Boolean(t?.current) || (t !== undefined && recorded < (chunks?.length ?? 0)),
    };
  });
};

/** The drift report as Markdown, for the job summary. */
export const driftMarkdown = (report) => {
  const rows = report.shards.map((s) =>
    typeof s.seconds === 'number'
      ? `| ${s.index} | ${Math.round(s.cost)} | ${duration(s.seconds)} | ${Math.round((s.seconds / report.budgetSeconds) * 100)} % |`
      : `| ${s.index} | ${Math.round(s.cost)} | n/a | n/a |`,
  );
  const stats =
    report.slowest === null
      ? 'No shard reported a timing.'
      : `Slowest: ${duration(report.slowest)}. Mean: ${duration(report.mean)}. Imbalance (slowest / mean): ${report.imbalance.toFixed(2)}.`;
  return [
    '### Mutation shards',
    '',
    '| Shard | Planned cost | Duration | Share of budget |',
    '| ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    stats,
    ...(report.warnings.length ? ['', ...report.warnings.map((w) => `- ${w}`)] : []),
  ].join('\n');
};

/**
 * One warning is noise; the same one run after run means the plan needs more
 * shards or chunks. Escalates on the third drifting run in a row.
 */
export const nextDriftHistory = (history, drifted, keep = 10) => {
  const next = [...history, drifted].slice(-keep);
  return { history: next, escalate: next.length >= 3 && next.slice(-3).every(Boolean) };
};

// --- edges --------------------------------------------------------------------

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const listFiles = (dir) =>
  readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    return entry.isDirectory() ? listFiles(rel) : [rel];
  });

const argValue = (args, name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const positiveInt = (value, name) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`${name} must be a positive integer, got ${value}`);
  return n;
};

const plan = async (args) => {
  const { inScope } = await loadConfig();
  const paths = listFiles('src').filter(inScope).sort();
  if (paths.length === 0) throw new Error('No file under src/ matches the mutate scope.');
  const sizes = Object.fromEntries(paths.map((p) => [p, statSync(join(repoRoot, p)).size]));
  const baselinePath = argValue(args, '--baseline');
  const baseline = (baselinePath && readJson(baselinePath)?.files) || {};
  const shards = planShards(estimateCosts(paths, baseline, sizes), {
    shards: positiveInt(argValue(args, '--shards') ?? 8, '--shards'),
    chunksPerShard: positiveInt(argValue(args, '--chunks') ?? 3, '--chunks'),
  });
  for (const s of shards) {
    console.error(`shard ${s.index}: cost ${Math.round(s.cost)}, ${s.chunks.flat().length} files`);
  }
  // One line on stdout: the workflow writes it to $GITHUB_OUTPUT as the matrix.
  console.log(
    JSON.stringify(
      shards.map(({ index, cost, chunks }) => ({ index, cost: Math.round(cost), chunks })),
    ),
  );
};

const runShard = async () => {
  const { incrementalFile } = await loadConfig();
  const chunks = JSON.parse(process.env.SHARD_CHUNKS ?? '[]');
  const done = [];
  let failed = 0;
  const timing = {
    index: Number(process.env.SHARD_INDEX),
    cost: Number(process.env.SHARD_COST),
    seconds: 0,
    chunks: [],
  };
  mkdirSync(join(repoRoot, SHARD_DIR), { recursive: true });
  const writeTiming = () =>
    replaceAtomically(join(repoRoot, SHARD_DIR, 'timing.json'), (tmp) =>
      writeFileSync(tmp, JSON.stringify(timing)),
    );
  for (const [i, chunk] of chunks.entries()) {
    console.log(`\n=== chunk ${i + 1}/${chunks.length}: ${chunk.join(', ')}\n`);
    const started = Date.now();
    // Written before the chunk runs: a kill inside it leaves `current` behind.
    timing.current = { files: chunk, started };
    writeTiming();
    const { status } = spawnSync(
      'pnpm',
      ['exec', 'stryker', 'run', '--incremental', '--mutate', chunk.join(',')],
      { cwd: repoRoot, stdio: 'inherit' },
    );
    const seconds = (Date.now() - started) / 1000;
    timing.seconds += seconds;
    timing.chunks.push({ files: chunk, seconds, ok: status === 0 });
    delete timing.current;
    writeTiming();
    // A failed chunk does not stop the next ones: each is independent progress.
    if (status !== 0) {
      failed += 1;
      console.error(`chunk ${i + 1} failed (exit ${status}).`);
      continue;
    }
    done.push(...chunk);
    replaceAtomically(join(repoRoot, SHARD_DIR, 'stryker-incremental.json'), (tmp) =>
      copyFileSync(join(repoRoot, incrementalFile), tmp),
    );
    replaceAtomically(join(repoRoot, SHARD_DIR, 'done.json'), (tmp) =>
      writeFileSync(tmp, JSON.stringify(done)),
    );
  }
  console.log(`\n${done.length} files finished; ${failed} chunk(s) failed.`);
  if (failed > 0) process.exit(1);
};

const merge = async (args) => {
  const out = argValue(args, '--out');
  if (!out) throw new Error('merge needs --out <file>');
  const fallbackPath = argValue(args, '--fallback');
  const dirs = args.filter(
    (a, i) => !a.startsWith('--') && !['--out', '--fallback'].includes(args[i - 1]),
  );
  const fallback = fallbackPath ? readJson(fallbackPath) : null;
  const shards = dirs.flatMap((dir) => {
    const report = readJson(join(dir, 'stryker-incremental.json'));
    const done = readJson(join(dir, 'done.json')) ?? [];
    if (!report?.files) {
      console.error(`${relative(repoRoot, dir) || dir}: no readable report, skipped.`);
      return [];
    }
    console.error(`${relative(repoRoot, dir) || dir}: ${done.length} files finished.`);
    return [{ report, done }];
  });
  // stdout: the number of shards merged, for the workflow to decide whether the
  // merged file is worth its own cache entry.
  console.log(shards.length);
  const merged = mergeReports({ fallbacks: fallback?.files ? [fallback] : [], shards });
  if (!merged) {
    console.error('Nothing to merge: the full pass will run cold.');
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(merged));
  console.error(`merged ${Object.keys(merged.files).length} files into ${out}`);
};

const drift = (args) => {
  const budgetSeconds =
    positiveInt(argValue(args, '--budget-minutes') ?? 75, '--budget-minutes') * 60;
  const historyIn = argValue(args, '--history');
  const historyOut = argValue(args, '--history-out');
  const summaryPath = argValue(args, '--summary');
  const flags = ['--budget-minutes', '--history', '--history-out', '--summary'];
  const dirs = args.filter((a, i) => !a.startsWith('--') && !flags.includes(args[i - 1]));
  const timings = dirs.map((dir) => readJson(join(dir, 'timing.json'))).filter(Boolean);
  const planned = JSON.parse(process.env.SHARD_PLAN ?? '[]');
  const shards = shardTimings(planned, timings);
  const report = driftReport({ shards, budgetSeconds });
  const drifted = report.warnings.length > 0;
  const { history, escalate } = nextDriftHistory((historyIn && readJson(historyIn)) || [], drifted);
  if (historyOut) {
    mkdirSync(dirname(historyOut), { recursive: true });
    writeFileSync(historyOut, JSON.stringify(history));
  }
  if (summaryPath) writeFileSync(summaryPath, `${driftMarkdown(report)}\n`, { flag: 'a' });
  // Annotations on the run page; they do not fail it.
  for (const warning of report.warnings)
    console.log(`::warning title=Mutation shard drift::${warning}`);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `drifted=${drifted}\nescalate=${escalate}\n`, {
      flag: 'a',
    });
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'plan') await plan(args);
  else if (command === 'run-shard') await runShard();
  else if (command === 'merge') await merge(args);
  else if (command === 'drift') drift(args);
  else {
    console.error('usage: mutation-shards.mjs plan | run-shard | merge | drift (see the header)');
    process.exit(2);
  }
}
