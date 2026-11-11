#!/usr/bin/env node
// Splits the full mutation baseline into shards of chunks that each finish
// inside one CI job, runs one shard, and merges them back. Why, and how the
// pieces fit: docs/decisions/mutation-testing.md, section 4. Used by mutation.yml:
//
//   node scripts/mutation-shards.mjs plan --shards N --chunks K [--baseline <file>]
//   node scripts/mutation-shards.mjs run-shard     (chunks in $SHARD_CHUNKS, JSON)
//   node scripts/mutation-shards.mjs merge --out <file> [--fallback <file>] <shard dir>...

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
  const staleFiles = (report) =>
    new Set(
      Object.entries(report.testFiles ?? {})
        .filter(([file, entry]) => entry.source !== testFiles[file]?.source)
        .map(([file]) => file),
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
  console.log(JSON.stringify(shards.map(({ index, chunks }) => ({ index, chunks }))));
};

const runShard = async () => {
  const { incrementalFile } = await loadConfig();
  const chunks = JSON.parse(process.env.SHARD_CHUNKS ?? '[]');
  const done = [];
  let failed = 0;
  mkdirSync(join(repoRoot, SHARD_DIR), { recursive: true });
  for (const [i, chunk] of chunks.entries()) {
    console.log(`\n=== chunk ${i + 1}/${chunks.length}: ${chunk.join(', ')}\n`);
    const { status } = spawnSync(
      'pnpm',
      ['exec', 'stryker', 'run', '--incremental', '--mutate', chunk.join(',')],
      { cwd: repoRoot, stdio: 'inherit' },
    );
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'plan') await plan(args);
  else if (command === 'run-shard') await runShard();
  else if (command === 'merge') await merge(args);
  else {
    console.error('usage: mutation-shards.mjs plan | run-shard | merge (see the header)');
    process.exit(2);
  }
}
