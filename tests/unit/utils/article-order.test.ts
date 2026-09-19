import { describe, expect, it } from 'vitest';
import {
  arrangeDesiredOrder,
  computePositionWrites,
  hasPositionInversion,
  isPlacedAsRequested,
  type OrderedArticle,
} from '../../../src/utils/article-order';

const ord = (pairs: [number, number][]): OrderedArticle[] =>
  pairs.map(([id, position]) => ({ id, position }));

describe('hasPositionInversion', () => {
  it('is false for a strictly increasing order', () => {
    expect(
      hasPositionInversion(
        ord([
          [1, 0],
          [2, 1],
          [3, 2],
        ]),
      ),
    ).toBe(false);
  });

  it('is false for ties (equal positions are not an inversion)', () => {
    expect(
      hasPositionInversion(
        ord([
          [1, 0],
          [2, 0],
          [3, 0],
        ]),
      ),
    ).toBe(false);
  });

  it('is true when a later article has a strictly smaller position', () => {
    expect(
      hasPositionInversion(
        ord([
          [1, 5],
          [2, 3],
          [3, 8],
        ]),
      ),
    ).toBe(true);
  });

  it('is false for empty or single-element orders', () => {
    expect(hasPositionInversion([])).toBe(false);
    expect(hasPositionInversion(ord([[1, 9]]))).toBe(false);
  });
});

describe('arrangeDesiredOrder', () => {
  const section = ord([
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 3],
  ]);

  it('moves an article to the top', () => {
    expect(arrangeDesiredOrder(section, 3, 'top').map((a) => a.id)).toEqual([3, 1, 2, 4]);
  });

  it('moves an article to the bottom', () => {
    expect(arrangeDesiredOrder(section, 2, 'bottom').map((a) => a.id)).toEqual([1, 3, 4, 2]);
  });

  it('places an article before a reference', () => {
    expect(arrangeDesiredOrder(section, 4, 'before', 2).map((a) => a.id)).toEqual([1, 4, 2, 3]);
  });

  it('places an article after a reference', () => {
    expect(arrangeDesiredOrder(section, 1, 'after', 3).map((a) => a.id)).toEqual([2, 3, 1, 4]);
  });

  it('throws when the moved article is absent', () => {
    expect(() => arrangeDesiredOrder(section, 99, 'top')).toThrow(/not in the section/);
  });

  it('throws when the reference is absent', () => {
    expect(() => arrangeDesiredOrder(section, 1, 'before', 99)).toThrow(/not in the section/);
  });
});

describe('computePositionWrites (gap-aware, default)', () => {
  it('bottom on a clean section is a single write above the max', () => {
    const section = ord([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    const desired = arrangeDesiredOrder(section, 1, 'bottom');
    expect(computePositionWrites(desired, 1, false)).toEqual([{ id: 1, position: 3 }]);
  });

  it('bottom anchors above the global max even when positions are unsorted', () => {
    const section = ord([
      [1, 10],
      [2, 3],
      [3, 5],
    ]);
    const desired = arrangeDesiredOrder(section, 2, 'bottom');
    expect(computePositionWrites(desired, 2, false)).toEqual([{ id: 2, position: 11 }]);
  });

  it('bottom is a no-op when the article is already last (idempotent)', () => {
    const section = ord([
      [1, 0],
      [2, 1],
      [3, 5],
    ]);
    const desired = arrangeDesiredOrder(section, 3, 'bottom');
    expect(computePositionWrites(desired, 3, false)).toEqual([]);
  });

  it('bottom on a single-article section is a no-op', () => {
    const section = ord([[1, 4]]);
    const desired = arrangeDesiredOrder(section, 1, 'bottom');
    expect(computePositionWrites(desired, 1, false)).toEqual([]);
  });

  it('top with slack below is a single write (position 0)', () => {
    const section = ord([
      [1, 5],
      [2, 6],
      [3, 7],
    ]);
    const desired = arrangeDesiredOrder(section, 3, 'top');
    expect(computePositionWrites(desired, 3, false)).toEqual([{ id: 3, position: 0 }]);
  });

  it('top on a fully-contiguous section cascades over the head only', () => {
    const section = ord([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 3],
      [5, 4],
    ]);
    const desired = arrangeDesiredOrder(section, 4, 'top');
    // 4 -> 0, then 1,2,3 shift up by one; article 5 (pos 4) is already clear → untouched.
    expect(computePositionWrites(desired, 4, false)).toEqual([
      { id: 4, position: 0 },
      { id: 1, position: 1 },
      { id: 2, position: 2 },
      { id: 3, position: 3 },
    ]);
  });

  it('breaks ties so a tied article becomes deterministically first (the #134 case)', () => {
    const section = ord([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
    ]);
    const desired = arrangeDesiredOrder(section, 4, 'top');
    // id 4 is already at 0, so it is left alone; the tied siblings are bumped up so
    // id 4 becomes uniquely first. Minimal: 3 writes, not 4.
    expect(computePositionWrites(desired, 4, false)).toEqual([
      { id: 1, position: 1 },
      { id: 2, position: 2 },
      { id: 3, position: 3 },
    ]);
  });

  it('before with an integer gap is a single write', () => {
    const section = ord([
      [1, 0],
      [2, 10],
      [3, 20],
    ]);
    const desired = arrangeDesiredOrder(section, 3, 'before', 2);
    expect(computePositionWrites(desired, 3, false)).toEqual([{ id: 3, position: 1 }]);
  });

  it('after a reference with no room cascades minimally', () => {
    const section = ord([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    // move 1 to after 2: desired [2,1,3]; 1 must sit between 2(pos1) and 3(pos2) → no room.
    const desired = arrangeDesiredOrder(section, 1, 'after', 2);
    expect(computePositionWrites(desired, 1, false)).toEqual([
      { id: 1, position: 2 },
      { id: 3, position: 3 },
    ]);
  });

  it('returns no writes when the article is already correctly placed', () => {
    const section = ord([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    const desired = arrangeDesiredOrder(section, 1, 'top');
    expect(computePositionWrites(desired, 1, false)).toEqual([]);
  });
});

describe('computePositionWrites (normalize)', () => {
  it('renumbers the whole section contiguously and only emits changed positions', () => {
    const section = ord([
      [1, 0],
      [2, 0],
      [3, 7],
      [4, 9],
    ]);
    const desired = arrangeDesiredOrder(section, 4, 'top');
    // desired ids [4,1,2,3] → contiguous 0,1,2,3. id 1 moves 0→1, id 4 moves 9→0, etc.
    expect(computePositionWrites(desired, 4, true)).toEqual([
      { id: 4, position: 0 },
      { id: 1, position: 1 },
      { id: 2, position: 2 },
      { id: 3, position: 3 },
    ]);
  });
});

describe('isPlacedAsRequested', () => {
  const after = ord([
    [3, 0],
    [1, 1],
    [2, 2],
    [4, 3],
  ]);

  it('confirms a top placement', () => {
    expect(isPlacedAsRequested(after, 3, 'top')).toBe(true);
    expect(isPlacedAsRequested(after, 1, 'top')).toBe(false);
  });

  it('confirms a bottom placement', () => {
    expect(isPlacedAsRequested(after, 4, 'bottom')).toBe(true);
    expect(isPlacedAsRequested(after, 2, 'bottom')).toBe(false);
  });

  it('confirms before/after placements by side, not strict adjacency', () => {
    // after = [3, 1, 2, 4]; article 1 is at index 1.
    expect(isPlacedAsRequested(after, 1, 'after', 3)).toBe(true); // 1 is after 3
    expect(isPlacedAsRequested(after, 1, 'before', 2)).toBe(true); // 1 is before 2
    expect(isPlacedAsRequested(after, 1, 'before', 4)).toBe(true); // 1 is before 4 (not adjacent, still before)
    expect(isPlacedAsRequested(after, 1, 'after', 2)).toBe(false); // 1 is NOT after 2
  });

  it('is false when the article or reference is missing', () => {
    expect(isPlacedAsRequested(after, 99, 'top')).toBe(false);
    expect(isPlacedAsRequested(after, 1, 'after', 99)).toBe(false);
  });
});

// Sections come back from Zendesk, and `noUncheckedIndexedAccess` is what makes
// every element access in this file possibly-undefined. The guards that follow
// from it are real code with a real contract -- a gap is skipped, not read --
// and nothing asserted it, so forcing any of them open changed no output.
describe('a section with a gap in it', () => {
  const withGap = [
    { id: 1, position: 0 },
    undefined,
    { id: 3, position: 2 },
  ] as unknown as OrderedArticle[];

  it('is not an inversion, and reading the gap does not throw', () => {
    expect(hasPositionInversion(withGap)).toBe(false);
  });

  it('stops the cascade at the gap instead of dereferencing it', () => {
    expect(computePositionWrites(withGap, 1, false)).toEqual([]);
  });
});

describe('computePositionWrites, at the boundaries', () => {
  it('moves a lone article at position 0 to the bottom without a write', () => {
    // The reduce seeds at -1 precisely so an empty "others" set leaves position 0
    // strictly above it. Seeding at +1 instead would make this a write to 2 --
    // a move that changes nothing, on every call.
    const section = ord([[1, 0]]);
    const desired = arrangeDesiredOrder(section, 1, 'bottom');
    expect(computePositionWrites(desired, 1, false)).toEqual([]);
  });

  it('writes when the article sent to the bottom merely ties the one above it', () => {
    // Strictly last is the requirement: tied-last displays in an undefined order,
    // which is the bug this tool exists to fix, so `>` and not `>=`.
    const section = ord([
      [1, 5],
      [2, 5],
    ]);
    const desired = arrangeDesiredOrder(section, 2, 'bottom');
    expect(computePositionWrites(desired, 2, false)).toEqual([{ id: 2, position: 6 }]);
  });

  it('returns nothing at all when the moved article is not in the desired order', () => {
    // Callers derive `desired` from the same list, so this is the contract of the
    // guard rather than a path the handler takes: without it the next line reads
    // `position` off undefined. The empty section is the case that actually
    // reaches that read: `findIndex` gives -1, which on an empty list is also
    // `length - 1`, so the bottom branch is entered and dereferences the miss.
    expect(computePositionWrites([], 99, false)).toEqual([]);
    const desired = ord([
      [1, 0],
      [2, 1],
    ]);
    expect(computePositionWrites(desired, 99, false)).toEqual([]);
  });

  it('normalize leaves an article already sitting at its index alone', () => {
    // The whole point of normalize emitting a *diff* rather than N writes: the
    // handler's confirm threshold counts them, and so does the user.
    const desired = ord([
      [1, 0],
      [2, 9],
      [3, 2],
    ]);
    expect(computePositionWrites(desired, 1, true)).toEqual([{ id: 2, position: 1 }]);
  });
});

describe('isPlacedAsRequested, at the boundaries', () => {
  const after = ord([
    [3, 0],
    [1, 1],
    [2, 2],
    [4, 3],
  ]);

  it('is false for a before that did not happen', () => {
    // The `true` branch of the side test needs a negative case of its own: every
    // other before/after assertion expects true, so a branch stuck on "yes"
    // reads as correct.
    expect(isPlacedAsRequested(after, 2, 'before', 1)).toBe(false);
  });

  it('is false when the moved article is absent and a reference was given', () => {
    // -1 sorts before every real index, so without the missing-article guard a
    // `before` check on an article that is not there reports success.
    expect(isPlacedAsRequested(after, 99, 'before', 3)).toBe(false);
  });

  it('never reports an article as placed relative to itself', () => {
    // The handler rejects movedId === referenceId before calling, but this
    // function promises nothing of the sort, and "an article is before itself"
    // is the one answer it must not give.
    expect(isPlacedAsRequested(after, 1, 'before', 1)).toBe(false);
    expect(isPlacedAsRequested(after, 1, 'after', 1)).toBe(false);
  });
});
