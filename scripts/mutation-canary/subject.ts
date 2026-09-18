// Fixture for the mutation canary (`scripts/mutation-canary.mjs`), never
// imported by the suite in `tests/`. One function the sibling test kills, one
// nothing reaches: the canary requires `Killed` for the first and `NoCoverage`
// for the second. The operators differ so each mutant stays identifiable by its
// replacement alone, wherever the lines move.
// Why both halves: docs/decisions/mutation-testing.md (§9).

export const killedByItsTest = (a: number, b: number): number => a + b;

export const reachedByNoTest = (a: number, b: number): number => a * b;
