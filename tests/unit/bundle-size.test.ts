import { describe, expect, it } from 'vitest';
import {
  ceilingsOf,
  evaluateBudget,
  logicalChunkName,
  packageBreakdown,
  renderReport,
  // @ts-expect-error - plain JS script, no type declarations
} from '../../scripts/bundle-size.mjs';

const budget = {
  tolerance: 0.1,
  floorBytes: 4096,
  shrinkNote: 0.8,
  references: { index: 100_000, http: 50_000, pkce: 3000 },
};
const ceiling = {
  factor: 1.5,
  baseline: {
    commit: 'abc1234',
    date: '2026-10-24',
    bytes: { index: 100_000, http: 50_000, total: 153_000 },
  },
};
const sizesOf = (chunks: Record<string, number>) => ({
  ...chunks,
  total: Object.values(chunks).reduce((sum, size) => sum + size, 0),
});

describe('logicalChunkName', () => {
  it('drops the content hash Rolldown appends, and the extension', () => {
    expect(logicalChunkName('index.js')).toBe('index');
    expect(logicalChunkName('http-DLa2DU80.js')).toBe('http');
    expect(logicalChunkName('article-sections-CzTODYsS.js')).toBe('article-sections');
    expect(logicalChunkName('token-store-BqwB-30K.js')).toBe('token-store');
    expect(logicalChunkName('pkce-DE_v9NQy.js')).toBe('pkce');
  });
});

describe('packageBreakdown', () => {
  it('sums the bytes of each package between region markers, largest first', () => {
    const source = [
      'import x;',
      '//#region node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core.js',
      'abcd',
      '//#endregion',
      '//#region node_modules/.pnpm/@modelcontextprotocol+server@2.3.1/node_modules/@modelcontextprotocol/server/dist/a.mjs',
      'abcdefgh',
      'ij',
      '//#endregion',
      '//#region src/server.ts',
      'abc',
      '//#endregion',
      '//#region \\0rolldown/runtime.js',
      'a',
    ].join('\n');

    expect(packageBreakdown(source)).toEqual([
      { name: '@modelcontextprotocol/server', bytes: 12 },
      { name: 'zod', bytes: 5 },
      { name: 'src', bytes: 4 },
      { name: 'rolldown', bytes: 2 },
    ]);
  });
});

describe('ceilingsOf', () => {
  it('multiplies the baseline by the factor, rounded down', () => {
    expect(ceilingsOf({ ...ceiling, factor: 1.333 })).toEqual({
      index: 133_300,
      http: 66_650,
      total: 203_949,
    });
  });
});

describe('evaluateBudget', () => {
  it('passes chunks within their reference and the ceilings', () => {
    const result = evaluateBudget(
      sizesOf({ index: 110_000, http: 50_000, pkce: 3000 }),
      budget,
      ceiling,
    );

    expect(result.violations).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it('fails a chunk more than the tolerance over its reference', () => {
    const result = evaluateBudget(
      sizesOf({ index: 110_001, http: 50_000, pkce: 3000 }),
      budget,
      ceiling,
    );

    expect(result.violations).toEqual([
      { tier: 'reference', kind: 'over', name: 'index', size: 110_001, reference: 100_000 },
    ]);
  });

  it('lets a small chunk grow by the floor rather than by a percentage of almost nothing', () => {
    expect(
      evaluateBudget(sizesOf({ index: 100_000, http: 50_000, pkce: 7096 }), budget, ceiling)
        .violations,
    ).toEqual([]);
    expect(
      evaluateBudget(sizesOf({ index: 100_000, http: 50_000, pkce: 7097 }), budget, ceiling)
        .violations,
    ).toEqual([{ tier: 'reference', kind: 'over', name: 'pkce', size: 7097, reference: 3000 }]);
  });

  it('fails a new chunk without a reference, and a referenced chunk that is gone', () => {
    const result = evaluateBudget(
      sizesOf({ index: 100_000, http: 50_000, extra: 10 }),
      budget,
      ceiling,
    );

    expect(result.violations).toEqual([
      { tier: 'reference', kind: 'unknown', name: 'extra', size: 10 },
      { tier: 'reference', kind: 'missing', name: 'pkce' },
    ]);
  });

  it('fails the ceiling even when the reference was raised to match', () => {
    // index is within its raised reference but over 1.5 × its baseline; the
    // total (203 KB) stays under its own ceiling (229.5 KB).
    const raised = { ...budget, references: { ...budget.references, index: 160_000 } };
    const result = evaluateBudget(
      sizesOf({ index: 150_001, http: 50_000, pkce: 3000 }),
      raised,
      ceiling,
    );

    expect(result.violations).toEqual([
      { tier: 'ceiling', kind: 'over', name: 'index', size: 150_001, ceiling: 150_000 },
    ]);
  });

  it('suggests lowering a reference the chunk fell well under', () => {
    const result = evaluateBudget(
      sizesOf({ index: 79_999, http: 40_000, pkce: 3000 }),
      budget,
      ceiling,
    );

    expect(result.violations).toEqual([]);
    expect(result.notes).toEqual([
      { kind: 'shrunk', name: 'index', size: 79_999, reference: 100_000 },
    ]);
  });
});

describe('renderReport', () => {
  it('tables every chunk, then explains what failed and lists what grew', () => {
    const sizes = sizesOf({ index: 120_000, http: 80_000, extra: 2048 });
    const result = evaluateBudget(sizes, budget, ceiling);
    const breakdowns = {
      index: [
        { name: '@modelcontextprotocol/server', bytes: 70_000 },
        { name: 'zod', bytes: 50_000 },
      ],
    };

    expect(renderReport(sizes, budget, ceiling, result, breakdowns)).toMatchInlineSnapshot(`
      "## Bundle size

      | Chunk | Size | Reference | vs reference | Ceiling | Ceiling headroom |
      | --- | ---: | ---: | ---: | ---: | ---: |
      | \`index\` | 117.2 KB | 97.7 KB | +20.0 % | 146.5 KB | 20.0 % |
      | \`http\` | 78.1 KB | 48.8 KB | +60.0 % | 73.2 KB | -6.7 % |
      | \`extra\` | 2.0 KB | — | — | — | — |
      | \`total\` | 197.3 KB | — | — | 224.1 KB | 12.0 % |

      ### 5 over budget

      - \`index\` is 117.2 KB, +20.0 % over its reference (97.7 KB; +10 % allowed).
      - \`http\` is 78.1 KB, +60.0 % over its reference (48.8 KB; +10 % allowed).
      - \`extra\` (2.0 KB) is a new chunk with no reference: add it to bundle-budget.json, and say in the PR what it is.
      - \`pkce\` has a reference but was not built: remove it from bundle-budget.json if it is gone on purpose.
      - \`http\` is 78.1 KB, over its ceiling of 73.2 KB (1.5 × the 48.8 KB measured at abc1234).

      The reference is a tripwire, not a hard limit. Find what grew in the breakdown below. If the growth is justified (a feature, a dependency upgrade), raise the reference in bundle-budget.json in this PR and say why; otherwise remove the cause (lazy loading, a narrower import, another dependency).

      The ceiling is not raised in a feature PR: shrink the bundle instead. Raising it takes the \`bundle-ceiling-raise\` label, a code-owner review and a new section in docs/decisions/startup-footprint.md.

      <details><summary>Largest packages in \`index\`</summary>

      - @modelcontextprotocol/server: 68.4 KB
      - zod: 48.8 KB

      </details>
      "
    `);
  });

  it('suggests lowering a reference without failing', () => {
    const sizes = sizesOf({ index: 70_000, http: 50_000, pkce: 3000 });
    const report = renderReport(sizes, budget, ceiling, evaluateBudget(sizes, budget, ceiling), {});

    expect(report).toContain(
      '`index` is -30.0 % under its reference: lower it in bundle-budget.json to keep the tripwire tight.',
    );
    expect(report).not.toContain('over budget');
  });
});
