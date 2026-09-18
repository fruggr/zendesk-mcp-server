import { describe, expect, it } from 'vitest';
import { killedByItsTest } from './subject.js';

// The nesting is load-bearing. Stryker filters a mutant's run with a regex over
// *qualified* test names, so a top-level `it` exercises a filter with no
// separator in it — the one shape that kept working when #297 broke everything
// else. Two levels of `describe` put a real separator on both sides of the join.
describe('the mutation canary subject', () => {
  describe('killedByItsTest', () => {
    it('returns the sum of its two arguments', () => {
      // Exact, so every mutant of `a + b` changes it.
      expect(killedByItsTest(2, 3)).toBe(5);
    });
  });
});
