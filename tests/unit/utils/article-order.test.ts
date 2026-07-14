import { describe, expect, it } from 'vitest';
import {
  arrangeDesiredOrder,
  computePositionWrites,
  hasPositionInversion,
  isPlacedAsRequested,
  type OrderedArticle,
} from '../../../src/utils/article-order';

const ord = (pairs: Array<[number, number]>): OrderedArticle[] =>
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

  it('confirms before/after placements', () => {
    expect(isPlacedAsRequested(after, 1, 'after', 3)).toBe(true);
    expect(isPlacedAsRequested(after, 1, 'before', 2)).toBe(true);
    expect(isPlacedAsRequested(after, 1, 'before', 4)).toBe(false);
  });

  it('is false when the article or reference is missing', () => {
    expect(isPlacedAsRequested(after, 99, 'top')).toBe(false);
    expect(isPlacedAsRequested(after, 1, 'after', 99)).toBe(false);
  });
});
