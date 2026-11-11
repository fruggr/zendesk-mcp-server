import { describe, expect, it } from 'vitest';
import {
  balance,
  costOfFile,
  estimateCosts,
  mergeReports,
  planShards,
  // @ts-expect-error -- plain .mjs helper, no declaration file (same as the other
  // script tests in this directory).
} from '../../scripts/mutation-shards.mjs';

// The baseline is split into shards that must each finish inside one job. A
// shard planned too heavy is killed and saves nothing, and a merge that keeps the
// wrong copy of a file replays a verdict computed for nothing.

const mutant = (fields: Record<string, unknown>) => ({ id: '1', status: 'Killed', ...fields });

describe('costOfFile', () => {
  it('sums the tests each mutant actually ran', () => {
    const entry = { mutants: [mutant({ testsCompleted: 3 }), mutant({ testsCompleted: 2800 })] };
    expect(costOfFile(entry)).toBe(2803);
  });

  it('counts an ignored mutant as free, since Stryker never runs it', () => {
    const entry = {
      mutants: [mutant({ status: 'Ignored', testsCompleted: 0 }), mutant({ testsCompleted: 4 })],
    };
    expect(costOfFile(entry)).toBe(4);
  });

  it('falls back to the covering tests, then to one, when the count is missing', () => {
    const entry = { mutants: [mutant({ coveredBy: ['a', 'b'] }), mutant({})] };
    expect(costOfFile(entry)).toBe(3);
  });
});

describe('estimateCosts', () => {
  it('uses the baseline where it has the file', () => {
    const baseline = { 'src/a.ts': { mutants: [mutant({ testsCompleted: 50 })] } };
    const costs = estimateCosts(['src/a.ts'], baseline, { 'src/a.ts': 1000 });
    expect(costs.get('src/a.ts')).toBe(50);
  });

  it('scales a file the baseline lacks by the cost per byte of the files it has', () => {
    const baseline = { 'src/a.ts': { mutants: [mutant({ testsCompleted: 50 })] } };
    const costs = estimateCosts(['src/a.ts', 'src/new.ts'], baseline, {
      'src/a.ts': 100,
      'src/new.ts': 300,
    });
    expect(costs.get('src/new.ts')).toBe(150);
  });

  it('falls back to the size alone on a cold run', () => {
    const costs = estimateCosts(['src/a.ts'], {}, { 'src/a.ts': 1234 });
    expect(costs.get('src/a.ts')).toBe(1234);
  });
});

describe('balance', () => {
  it('puts the heaviest item first on the lightest bin', () => {
    const bins = balance(
      [
        ['a', 10],
        ['b', 7],
        ['c', 5],
        ['d', 4],
      ],
      2,
    );
    expect(bins).toEqual([
      { paths: ['a', 'd'], cost: 14 },
      { paths: ['b', 'c'], cost: 12 },
    ]);
  });

  it('drops empty bins when there are fewer items than bins', () => {
    expect(balance([['a', 1]], 3)).toEqual([{ paths: ['a'], cost: 1 }]);
  });

  it('is deterministic on equal costs', () => {
    const items: [string, number][] = [
      ['b', 1],
      ['a', 1],
    ];
    expect(balance(items, 2)).toEqual([
      { paths: ['a'], cost: 1 },
      { paths: ['b'], cost: 1 },
    ]);
  });
});

describe('planShards', () => {
  it('splits each shard into chunks that Stryker runs one after another', () => {
    const costs = new Map([
      ['a', 8],
      ['b', 4],
      ['c', 4],
      ['d', 2],
      ['e', 2],
    ]);
    expect(planShards(costs, { shards: 2, chunksPerShard: 2 })).toEqual([
      { index: 0, cost: 10, chunks: [['a'], ['d']] },
      { index: 1, cost: 10, chunks: [['b', 'e'], ['c']] },
    ]);
  });
});

describe('mergeReports', () => {
  const report = (files: Record<string, unknown>, testFiles: Record<string, unknown> = {}) => ({
    schemaVersion: '2',
    thresholds: { high: 85, low: 70 },
    files,
    testFiles,
  });

  it('takes each file from the shard that finished it, over any reused copy', () => {
    const restored = report({ 'src/a.ts': 'old a', 'src/b.ts': 'old b' });
    const shard0 = {
      report: report({ 'src/a.ts': 'fresh a', 'src/b.ts': 'old b' }),
      done: ['src/a.ts'],
    };
    const shard1 = {
      report: report({ 'src/a.ts': 'old a', 'src/b.ts': 'fresh b' }),
      done: ['src/b.ts'],
    };
    const merged = mergeReports({ fallbacks: [restored], shards: [shard0, shard1] });
    expect(merged.files).toEqual({ 'src/a.ts': 'fresh a', 'src/b.ts': 'fresh b' });
  });

  it('keeps the restored copy of a file whose shard never finished it', () => {
    const restored = report({ 'src/a.ts': 'old a' });
    const killed = { report: report({ 'src/a.ts': 'half a' }), done: [] };
    expect(mergeReports({ fallbacks: [restored], shards: [killed] }).files).toEqual({
      'src/a.ts': 'old a',
    });
  });

  it('keeps a file only an unfinished shard knows, rather than losing its reused verdicts', () => {
    const shard = {
      report: report({ 'src/a.ts': 'reused a', 'src/b.ts': 'fresh b' }),
      done: ['src/b.ts'],
    };
    expect(mergeReports({ fallbacks: [], shards: [shard] }).files).toEqual({
      'src/a.ts': 'reused a',
      'src/b.ts': 'fresh b',
    });
  });

  it('prefers the test files the shards ran over the restored ones', () => {
    const restored = report({}, { 't/a.test.ts': 'old ta', 't/old.test.ts': 'gone?' });
    const shard = { report: report({}, { 't/a.test.ts': 'new ta' }), done: [] };
    expect(mergeReports({ fallbacks: [restored], shards: [shard] }).testFiles).toEqual({
      't/a.test.ts': 'new ta',
      't/old.test.ts': 'gone?',
    });
  });

  it('unions the test files every shard ran', () => {
    const shard0 = { report: report({}, { 't/a.test.ts': 'ta' }), done: [] };
    const shard1 = { report: report({}, { 't/b.test.ts': 'tb' }), done: [] };
    expect(mergeReports({ fallbacks: [], shards: [shard0, shard1] }).testFiles).toEqual({
      't/a.test.ts': 'ta',
      't/b.test.ts': 'tb',
    });
  });

  it('carries the top-level fields of the reports', () => {
    const merged = mergeReports({ fallbacks: [], shards: [{ report: report({}), done: [] }] });
    expect(merged.schemaVersion).toBe('2');
    expect(merged.thresholds).toEqual({ high: 85, low: 70 });
  });

  it('returns null when there is nothing to merge', () => {
    expect(mergeReports({ fallbacks: [], shards: [] })).toBeNull();
  });
});
