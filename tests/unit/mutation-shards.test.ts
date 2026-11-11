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
  interface Test {
    id: string;
    name: string;
  }
  const report = (
    files: Record<string, string>,
    testFiles: Record<string, Test[]> = {},
    coveredBy: string[] = [],
  ) => ({
    schemaVersion: '2',
    thresholds: { high: 85, low: 70 },
    files: Object.fromEntries(
      Object.entries(files).map(([path, tag]) => [
        path,
        { language: 'typescript', mutants: [{ id: tag, status: 'Killed', coveredBy }] },
      ]),
    ),
    testFiles: Object.fromEntries(
      Object.entries(testFiles).map(([file, tests]) => [file, { source: `src of ${file}`, tests }]),
    ),
  });
  const tagOf = (merged: { files: Record<string, { mutants: { id: string }[] }> }) =>
    Object.fromEntries(Object.entries(merged.files).map(([p, f]) => [p, f.mutants[0]?.id]));

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
    expect(tagOf(merged)).toEqual({ 'src/a.ts': 'fresh a', 'src/b.ts': 'fresh b' });
  });

  it('keeps the restored copy of a file whose shard never finished it', () => {
    const restored = report({ 'src/a.ts': 'old a' });
    const killed = { report: report({ 'src/a.ts': 'half a' }), done: [] };
    expect(tagOf(mergeReports({ fallbacks: [restored], shards: [killed] }))).toEqual({
      'src/a.ts': 'old a',
    });
  });

  it('keeps a file only an unfinished shard knows, rather than losing its reused verdicts', () => {
    const shard = {
      report: report({ 'src/a.ts': 'reused a', 'src/b.ts': 'fresh b' }),
      done: ['src/b.ts'],
    };
    expect(tagOf(mergeReports({ fallbacks: [], shards: [shard] }))).toEqual({
      'src/a.ts': 'reused a',
      'src/b.ts': 'fresh b',
    });
  });

  it("keeps every test a file had in any shard, not only the last shard's subset", () => {
    const shard0 = { report: report({}, { 't/a.test.ts': [{ id: '0', name: 'one' }] }), done: [] };
    const shard1 = { report: report({}, { 't/a.test.ts': [{ id: '0', name: 'two' }] }), done: [] };
    const merged = mergeReports({ fallbacks: [], shards: [shard0, shard1] });
    expect(merged.testFiles['t/a.test.ts'].tests.map((t: Test) => t.name)).toEqual(['one', 'two']);
  });

  it('renumbers tests so a mutant still points at the tests it ran in its own shard', () => {
    // Both shards call their only test "0", but they are different tests.
    const shard0 = {
      report: report({ 'src/a.ts': 'a' }, { 't/a.test.ts': [{ id: '0', name: 'covers a' }] }, [
        '0',
      ]),
      done: ['src/a.ts'],
    };
    const shard1 = {
      report: report({ 'src/b.ts': 'b' }, { 't/b.test.ts': [{ id: '0', name: 'covers b' }] }, [
        '0',
      ]),
      done: ['src/b.ts'],
    };
    const merged = mergeReports({ fallbacks: [], shards: [shard0, shard1] });
    const nameOf = (id: string) =>
      Object.values(merged.testFiles as Record<string, { tests: Test[] }>)
        .flatMap((f) => f.tests)
        .find((t) => t.id === id)?.name;
    expect(merged.files['src/a.ts'].mutants[0].coveredBy.map(nameOf)).toEqual(['covers a']);
    expect(merged.files['src/b.ts'].mutants[0].coveredBy.map(nameOf)).toEqual(['covers b']);
  });

  it('renumbers the killing tests the same way', () => {
    const killedBy = (r: ReturnType<typeof report>, path: string, ids: string[]) => {
      Object.assign(r.files[path]?.mutants[0] ?? {}, { killedBy: ids });
      return r;
    };
    const shard0 = {
      report: killedBy(
        report({ 'src/a.ts': 'a' }, { 't/a.test.ts': [{ id: '0', name: 'kills a' }] }),
        'src/a.ts',
        ['0'],
      ),
      done: ['src/a.ts'],
    };
    const shard1 = {
      report: killedBy(
        report({ 'src/b.ts': 'b' }, { 't/b.test.ts': [{ id: '0', name: 'kills b' }] }),
        'src/b.ts',
        ['0'],
      ),
      done: ['src/b.ts'],
    };
    const merged = mergeReports({ fallbacks: [], shards: [shard0, shard1] });
    const nameOf = (id: string) =>
      Object.values(merged.testFiles as Record<string, { tests: Test[] }>)
        .flatMap((f) => f.tests)
        .find((t) => t.id === id)?.name;
    expect(merged.files['src/a.ts'].mutants[0].killedBy.map(nameOf)).toEqual(['kills a']);
    expect(merged.files['src/b.ts'].mutants[0].killedBy.map(nameOf)).toEqual(['kills b']);
  });

  it('prefers the test sources the shards ran over the restored ones', () => {
    const restored = {
      ...report({}),
      testFiles: { 't/a.test.ts': { source: 'old source', tests: [{ id: '0', name: 'one' }] } },
    };
    const shard = { report: report({}, { 't/a.test.ts': [{ id: '3', name: 'one' }] }), done: [] };
    const merged = mergeReports({ fallbacks: [restored], shards: [shard] });
    expect(merged.testFiles['t/a.test.ts'].source).toBe('src of t/a.test.ts');
    expect(merged.testFiles['t/a.test.ts'].tests).toHaveLength(1);
  });

  it('drops a kept verdict whose covering test changed since it was computed', () => {
    // The restored baseline killed `b` with a test the shard now runs in a new version.
    const restored = {
      ...report({ 'src/b.ts': 'b' }, {}, ['0']),
      testFiles: { 't/b.test.ts': { source: 'old body', tests: [{ id: '0', name: 'covers b' }] } },
    };
    const shard = {
      report: report({ 'src/a.ts': 'a' }, { 't/b.test.ts': [{ id: '0', name: 'covers b' }] }, [
        '0',
      ]),
      done: ['src/a.ts'],
    };
    const merged = mergeReports({ fallbacks: [restored], shards: [shard] });
    expect(merged.files['src/b.ts'].mutants).toEqual([]);
    expect(tagOf(merged)['src/a.ts']).toBe('a');
  });

  it('keeps a kept verdict whose covering tests did not change', () => {
    const restored = {
      ...report({ 'src/b.ts': 'b' }, {}, ['0']),
      testFiles: {
        't/b.test.ts': { source: 'src of t/b.test.ts', tests: [{ id: '0', name: 'covers b' }] },
      },
    };
    const shard = {
      report: report({ 'src/a.ts': 'a' }, { 't/b.test.ts': [{ id: '0', name: 'covers b' }] }, [
        '0',
      ]),
      done: ['src/a.ts'],
    };
    expect(tagOf(mergeReports({ fallbacks: [restored], shards: [shard] }))['src/b.ts']).toBe('b');
  });

  it('drops a kept static verdict when a shard brings a test file the baseline never ran', () => {
    const restored = report(
      { 'src/b.ts': 'b' },
      { 't/b.test.ts': [{ id: '0', name: 'covers b' }] },
    );
    Object.assign(restored.files['src/b.ts']?.mutants[0] ?? {}, { static: true });
    const shard = {
      report: report(
        { 'src/a.ts': 'a' },
        {
          't/b.test.ts': [{ id: '0', name: 'covers b' }],
          't/new.test.ts': [{ id: '1', name: 'new test' }],
        },
      ),
      done: ['src/a.ts'],
    };
    const merged = mergeReports({ fallbacks: [restored], shards: [shard] });
    expect(merged.files['src/b.ts'].mutants).toEqual([]);
  });

  it('keeps a kept per-test verdict when the only new test file does not cover it', () => {
    const restored = report(
      { 'src/b.ts': 'b' },
      { 't/b.test.ts': [{ id: '0', name: 'covers b' }] },
      ['0'],
    );
    const shard = {
      report: report(
        { 'src/a.ts': 'a' },
        {
          't/b.test.ts': [{ id: '0', name: 'covers b' }],
          't/new.test.ts': [{ id: '1', name: 'new test' }],
        },
      ),
      done: ['src/a.ts'],
    };
    expect(tagOf(mergeReports({ fallbacks: [restored], shards: [shard] }))['src/b.ts']).toBe('b');
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
