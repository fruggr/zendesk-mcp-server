// Fixture for the mutation canary — driven by `scripts/mutation-canary.mjs`,
// never imported by the suite in `tests/`.
//
// Two one-line functions, and the canary demands a *different* verdict for
// each: `killedByItsTest` is asserted exactly by the sibling test, so its
// mutant must come back `Killed`; nothing calls `reachedByNoTest`, so its
// mutant must come back `NoCoverage`. Requiring both is what makes the canary
// two-sided — a runner that reported every mutant killed would pass a
// one-sided check while telling us just as little.
//
// The operators differ (`+` against `*`) so each mutant is identifiable by its
// replacement text alone, which survives the fixture moving up or down a line.

export const killedByItsTest = (a: number, b: number): number => a + b;

export const reachedByNoTest = (a: number, b: number): number => a * b;
