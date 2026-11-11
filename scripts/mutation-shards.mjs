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
 * chunk (even mid-write) cannot spoil what was finished.
 */
export const SHARD_DIR = 'reports/shard';

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

/**
 * One baseline from the shards. Every report already carries reused copies of
 * the files it did not mutate, so precedence is what matters. Files: whatever
 * the shards reused, then the restored baseline over it, then each file from the
 * shard that finished it (a file whose shard was killed keeps its older copy).
 * Test files: the shards' over the restored ones, since the shards ran this
 * commit's tests; a stale copy would make the next run re-test everything.
 */
export const mergeReports = ({ fallbacks, shards }) => {
  const shardReports = shards.map((s) => s.report);
  const reports = [...shardReports, ...fallbacks];
  if (reports.length === 0) return null;
  const files = {};
  for (const report of reports) Object.assign(files, report.files);
  const testFiles = {};
  for (const report of [...fallbacks, ...shardReports]) Object.assign(testFiles, report.testFiles);
  for (const { report, done } of shards) {
    for (const path of done) if (report.files?.[path]) files[path] = report.files[path];
  }
  return { ...reports.at(-1), files, testFiles };
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
    copyFileSync(
      join(repoRoot, incrementalFile),
      join(repoRoot, SHARD_DIR, 'stryker-incremental.json'),
    );
    writeFileSync(join(repoRoot, SHARD_DIR, 'done.json'), JSON.stringify(done));
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
