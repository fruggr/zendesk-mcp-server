import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs helper, no declaration file (same as the other
// script tests in this directory).
import {
  changedRanges,
  escapedMutants,
  scoreOf,
  specsFor,
  tallyStatuses,
} from '../../scripts/mutation-scope.mjs';

// The PR gate decides whether a change was tested, so its own parsing and
// range arithmetic need pinning: a silent off-by-one here stops guarding a line
// without anything failing. Fixtures are real `git diff --unified=0
// --diff-filter=d` output and real `mutation-testing-report-schema` shapes.

const inScope = (path: string) => path.startsWith('src/utils/');

describe('changedRanges', () => {
  it('reads a single-line hunk, where git omits the count', () => {
    // `+69` with no `,count` means exactly one line.
    const diff = [
      '--- a/src/utils/pagination.ts',
      '+++ b/src/utils/pagination.ts',
      '@@ -69 +69 @@',
    ].join('\n');
    expect(changedRanges(diff, inScope)).toEqual([
      { file: 'src/utils/pagination.ts', start: 69, end: 69 },
    ]);
  });

  it('turns a multi-line hunk into an inclusive range', () => {
    const diff = ['+++ b/src/utils/logger.ts', '@@ -56,4 +56,33 @@'].join('\n');
    expect(changedRanges(diff, inScope)).toEqual([
      { file: 'src/utils/logger.ts', start: 56, end: 88 },
    ]);
  });

  it('collects every hunk of a file', () => {
    const diff = ['+++ b/src/utils/logger.ts', '@@ -56,4 +56,33 @@', '@@ -102,2 +126,7 @@'].join(
      '\n',
    );
    expect(changedRanges(diff, inScope)).toEqual([
      { file: 'src/utils/logger.ts', start: 56, end: 88 },
      { file: 'src/utils/logger.ts', start: 126, end: 132 },
    ]);
  });

  it('skips a hunk that only deletes lines', () => {
    // `+40,0` — nothing on the head side, so nothing to mutate.
    const diff = ['+++ b/src/utils/logger.ts', '@@ -40,3 +40,0 @@'].join('\n');
    expect(changedRanges(diff, inScope)).toEqual([]);
  });

  it('ignores files outside the mutate scope, including their hunks', () => {
    // The out-of-scope file's hunk must not be attributed to the previous file.
    const diff = [
      '+++ b/src/utils/logger.ts',
      '@@ -1 +1 @@',
      '+++ b/src/tools/help-center.ts',
      '@@ -500,2 +500,9 @@',
      '+++ b/README.md',
      '@@ -1,5 +1,9 @@',
    ].join('\n');
    expect(changedRanges(diff, inScope)).toEqual([
      { file: 'src/utils/logger.ts', start: 1, end: 1 },
    ]);
  });

  it('returns nothing for an empty diff', () => {
    expect(changedRanges('', inScope)).toEqual([]);
  });

  it('does not mistake a diff body line for a hunk header', () => {
    // A test fixture or doc line can legitimately start with `@@`.
    const diff = ['+++ b/src/utils/logger.ts', '@@ -1 +1 @@', "+const s = '@@ -9 +9 @@';"].join(
      '\n',
    );
    expect(changedRanges(diff, inScope)).toEqual([
      { file: 'src/utils/logger.ts', start: 1, end: 1 },
    ]);
  });
});

describe('specsFor', () => {
  it('renders Stryker mutate specs, comma-separated', () => {
    expect(
      specsFor([
        { file: 'src/utils/logger.ts', start: 56, end: 88 },
        { file: 'src/utils/logger.ts', start: 126, end: 132 },
      ]),
    ).toBe('src/utils/logger.ts:56-88,src/utils/logger.ts:126-132');
  });

  it('renders an empty string when there is nothing in scope', () => {
    expect(specsFor([])).toBe('');
  });
});

const mutant = (line: number, status: string, endLine = line) => ({
  status,
  mutatorName: 'StringLiteral',
  replacement: '""',
  location: { start: { line, column: 1 }, end: { line: endLine, column: 9 } },
});

describe('escapedMutants', () => {
  const ranges = [{ file: 'src/utils/logger.ts', start: 56, end: 88 }];

  it('judges only mutants inside the changed ranges', () => {
    const report = {
      files: {
        'src/utils/logger.ts': {
          mutants: [mutant(55, 'Survived'), mutant(56, 'Killed'), mutant(89, 'Survived')],
        },
      },
    };
    // 55 and 89 sit either side of the range and must not be judged.
    expect(escapedMutants(ranges, report)).toEqual({ judged: 1, escaped: [] });
  });

  it('counts both Survived and NoCoverage as escaped', () => {
    const report = {
      files: {
        'src/utils/logger.ts': {
          mutants: [mutant(60, 'Survived'), mutant(61, 'NoCoverage'), mutant(62, 'Killed')],
        },
      },
    };
    const { judged, escaped } = escapedMutants(ranges, report);
    expect(judged).toBe(3);
    expect(escaped.map((e) => e.line)).toEqual([60, 61]);
  });

  it('treats Timeout as detected, not escaped', () => {
    const report = { files: { 'src/utils/logger.ts': { mutants: [mutant(60, 'Timeout')] } } };
    expect(escapedMutants(ranges, report)).toEqual({ judged: 1, escaped: [] });
  });

  it('judges a mutant that straddles the range boundary', () => {
    // Starts before the range, ends inside it — the change is still implicated.
    const report = { files: { 'src/utils/logger.ts': { mutants: [mutant(50, 'Survived', 57)] } } };
    expect(escapedMutants(ranges, report).judged).toBe(1);
  });

  it('ignores a file the diff did not touch, even when it has survivors', () => {
    // `--incremental` emits the whole project report; this is what keeps the
    // gate about the PR rather than about the repo's history.
    const report = {
      files: {
        'src/utils/formatting.ts': { mutants: [mutant(60, 'Survived'), mutant(61, 'Survived')] },
      },
    };
    expect(escapedMutants(ranges, report)).toEqual({ judged: 0, escaped: [] });
  });

  it('tolerates a report with no files and a file with no mutants', () => {
    expect(escapedMutants(ranges, {})).toEqual({ judged: 0, escaped: [] });
    expect(escapedMutants(ranges, { files: { 'src/utils/logger.ts': {} } })).toEqual({
      judged: 0,
      escaped: [],
    });
  });
});

describe('tallyStatuses and scoreOf', () => {
  it('tallies across files and scores detected over judged', () => {
    const report = {
      files: {
        'src/utils/a.ts': { mutants: [mutant(1, 'Killed'), mutant(2, 'Survived')] },
        'src/utils/b.ts': { mutants: [mutant(1, 'Timeout'), mutant(2, 'NoCoverage')] },
      },
    };
    const counts = tallyStatuses(report);
    expect(counts).toEqual({ Killed: 1, Survived: 1, Timeout: 1, NoCoverage: 1 });
    // Killed + Timeout over all four.
    expect(scoreOf(counts)).toBe(50);
  });

  it('excludes compile errors from the denominator', () => {
    // Stryker reports mutants that never ran as errors; scoring them would
    // punish a run for something no test could have caught.
    expect(scoreOf({ Killed: 1, RuntimeError: 3, CompileError: 5 })).toBe(100);
  });

  it('returns null rather than dividing by zero on an empty report', () => {
    expect(scoreOf(tallyStatuses({}))).toBeNull();
  });
});
