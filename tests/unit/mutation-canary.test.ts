import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs helper, no declaration file (same as the other
// script tests in this directory).
import { EXPECTED_VERDICTS, judgeCanary } from '../../scripts/mutation-canary.mjs';

// The canary decides whether the mutation gate is measuring anything at all, so
// its verdict-reading is pinned here: a judge that waves a broken report
// through is exactly as silent as the failure it exists to catch (#297), and
// nothing downstream would notice. The reports below are real
// `mutation-testing-report-schema` shapes, trimmed to the fields read.

const SUBJECT = 'scripts/mutation-canary/subject.ts';

const mutant = (replacement: string, status: string, line = 14) => ({
  status,
  mutatorName: 'ArithmeticOperator',
  replacement,
  location: { start: { line, column: 48 }, end: { line, column: 53 } },
});

const report = (...mutants: ReturnType<typeof mutant>[]) => ({
  files: { [SUBJECT]: { mutants } },
});

const healthy = () => report(mutant('a - b', 'Killed'), mutant('a / b', 'NoCoverage', 16));

describe('judgeCanary', () => {
  it('passes the report a working runner produces', () => {
    expect(judgeCanary(healthy())).toEqual([]);
  });

  it('names the #297 regression: the killed mutant comes back survived', () => {
    const broken = report(mutant('a - b', 'Survived'), mutant('a / b', 'NoCoverage', 16));
    expect(judgeCanary(broken)).toEqual(['`a - b`: expected Killed, reported Survived.']);
  });

  it('fails an empty report instead of finding nothing to complain about', () => {
    // The shape a run that collapsed produces, and the one a "no mutant
    // escaped" check would wave through.
    expect(judgeCanary({})).toMatchInlineSnapshot(`
      [
        "no mutant replaced anything with \`a - b\` — expected one, reported Killed.",
        "no mutant replaced anything with \`a / b\` — expected one, reported NoCoverage.",
      ]
    `);
  });

  it('fails when the uncovered mutant is reported as killed', () => {
    // The other direction: a runner that reported everything killed would pass
    // a one-sided check while saying just as little.
    const broken = report(mutant('a - b', 'Killed'), mutant('a / b', 'Killed', 16));
    expect(judgeCanary(broken)).toEqual(['`a / b`: expected NoCoverage, reported Killed.']);
  });

  it('skips Ignored mutants, which carry no verdict', () => {
    // `excludedMutations` and `// Stryker disable` both land here; the fixture's
    // ArrowFunction mutants are excluded this way.
    const withIgnored = report(
      mutant('a - b', 'Killed'),
      mutant('a / b', 'NoCoverage', 16),
      { ...mutant('() => undefined', 'Ignored'), mutatorName: 'ArrowFunction' },
      { ...mutant('() => undefined', 'Ignored', 16), mutatorName: 'ArrowFunction' },
    );
    expect(judgeCanary(withIgnored)).toEqual([]);
  });

  it('reports a mutant the expectations do not cover', () => {
    // A toolchain upgrade that adds a mutator lands here, and it has to be read
    // rather than absorbed: an unrecognised mutant means the fixture no longer
    // pins what the canary claims it pins.
    const drifted = report(mutant('a % b', 'Survived'), ...healthy().files[SUBJECT].mutants);
    expect(judgeCanary(drifted)).toMatchInlineSnapshot(`
      [
        "scripts/mutation-canary/subject.ts:14 produced an unexpected mutant \`a % b\` (Survived) — the fixture or the set of mutators applied to it has changed. Check the verdict is the right one, then say so in EXPECTED_VERDICTS.",
      ]
    `);
  });

  it('refuses to judge two mutants sharing one replacement', () => {
    // The key has to stay unique, or one verdict silently stands in for two.
    const ambiguous = report(mutant('a - b', 'Killed'), mutant('a - b', 'Survived', 16));
    expect(judgeCanary(ambiguous)).toEqual([
      'scripts/mutation-canary/subject.ts: two mutants share the replacement `a - b`',
      'no mutant replaced anything with `a / b` — expected one, reported NoCoverage.',
    ]);
  });

  it('does not take an inherited property name for an expected mutant', () => {
    // `'constructor' in expected` is true of any object literal, so an `in`
    // check would treat this mutant as expected and then never judge it — a
    // hole in the exhaustiveness the canary's whole claim rests on.
    expect(
      judgeCanary(report(mutant('constructor', 'Survived')), { 'a - b': 'Killed' }),
    ).toMatchInlineSnapshot(`
        [
          "scripts/mutation-canary/subject.ts:14 produced an unexpected mutant \`constructor\` (Survived) — the fixture or the set of mutators applied to it has changed. Check the verdict is the right one, then say so in EXPECTED_VERDICTS.",
          "no mutant replaced anything with \`a - b\` — expected one, reported Killed.",
        ]
      `);
  });

  it('states both verdicts the fixture guarantees', () => {
    // Pinned because the pair is the whole design: one killed, one unreached.
    expect(EXPECTED_VERDICTS).toEqual({ 'a - b': 'Killed', 'a / b': 'NoCoverage' });
  });
});
