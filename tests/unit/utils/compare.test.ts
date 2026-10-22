import { describe, expect, it } from 'vitest';
import { compareCodeUnits } from '../../../src/utils/compare';

describe('compareCodeUnits', () => {
  it.each([
    ['a', 'b', -1],
    ['b', 'a', 1],
    ['a', 'a', 0],
  ])('compares %s with %s as %d', (a, b, expected) => {
    expect(compareCodeUnits(a, b)).toBe(expected);
  });

  it('sorts like the default sort, by code unit rather than by locale', () => {
    const values = ['b', 'B', 'a', 'é', 'e', 'Z', '10', '9'];

    expect(values.toSorted(compareCodeUnits)).toEqual(['10', '9', 'B', 'Z', 'a', 'b', 'e', 'é']);
  });
});
