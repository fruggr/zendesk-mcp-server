# StrykerJS + vitest 5: the diagnosis, and where it stands upstream

> **Build documentation, not user documentation.** This is the diagnosis behind
> the vitest hold recorded in
> [`mutation-testing.md` section 9](./mutation-testing.md#9-the-canary-and-why-vitest-is-held-at-4x).
> Nothing here affects how the MCP server behaves for a client.

**Upstream already has it.**
[stryker-js#6210](https://github.com/stryker-mutator/stryker-js/issues/6210)
(opened 2026-09-04) names the same cause, and
[stryker-js#6214](https://github.com/stryker-mutator/stryker-js/pull/6214)
proposes the fix — parametrise the separator in `collectTestName` /
`toRawTestId` and pick `' > '` for vitest 5+. **Open, unmerged** when this was
written, so the hold stands until a release ships it; no new issue was filed,
because a duplicate report helps nobody.

This file is kept anyway, and not as a courtesy to itself: it is the evidence
that our reading of the failure is our own rather than a repeat of the upstream
issue's, and it is what the next person needs when they decide whether a runner
release really lifts the hold. Everything below was measured on this repository —
reproduce it with the commands in the last section. Upstream's own evidence is
larger in scale and identical in shape (a project score of 47.36 → 2.96, with
1398 of 1651 survivors carrying `testsCompleted: 0` against a populated
`coveredBy`), which is worth one line here because two independent measurements
of the same mechanism is the strongest statement available about the cause.

---

## Summary

*(What follows is the report as it was written before finding #6210 — kept
because it is the reproduction, not a proposal.)*

With `vitest@5`, `@stryker-mutator/vitest-runner` runs **zero tests** for every
mutant it scopes to a test filter, and reports each of those mutants as
**`Survived`**. Nothing errors and nothing warns: the run completes, the report
is well-formed, and the mutation score is simply wrong in the direction that
hides test gaps behind phantom survivors.

`@stryker-mutator/vitest-runner@10.0.0` declares `vitest: ">=2.0.0"`, so vitest 5
satisfies the peer range and installs clean.

## Versions

| | |
| --- | --- |
| `@stryker-mutator/core` | 10.0.0 |
| `@stryker-mutator/vitest-runner` | 10.0.0 |
| `vitest` | 5.0.0 (also checked: 5.0.1) |
| Node | 22.22.2 |
| `coverageAnalysis` | `perTest` (the default) |

## What it looks like

Same tree, same 44 mutants, nothing changed but the vitest version:

| vitest | result |
| --- | --- |
| 4.1.11 | `Killed: 44. Escaped: 0.` |
| 5.0.0 | `Killed: 7. Escaped: 37.` |

The survivors are phantom. Taking one Stryker reports as survived and applying
it by hand:

```diff
-  Math.round((t - now) / 60_000)
+  Math.round((t - now) * 60_000)
```

`vitest run tests/unit/utils/formatting.test.ts` then fails **11 snapshots** on
the same tree where Stryker calls the mutant survived.

## Root cause

This is a **test-filter** failure, not a result-reporting one.

`VitestTestRunner.run()` narrows a mutant's run to its covering tests by writing
a regex into `project.config.testNamePattern`
(`packages/vitest-runner/src/vitest-test-runner.ts`). The names that regex is
built from come from the runner's own `collectTestName()`
(`packages/vitest-runner/src/test-helpers.ts`), which joins suite names and the
test name with a **single space**:

```ts
const nameParts = [name];
let currentSuite = suite;
while (currentSuite) {
  nameParts.unshift(currentSuite.name);
  currentSuite = currentSuite.suite;
}
return nameParts.join(' ').trim();
```

What vitest matches that pattern against changed in 5.0.0:

| | matched against | built by |
| --- | --- | --- |
| vitest 4.1.11 | `getTaskFullName(task)` — `` `${suite ? `${getTaskFullName(suite)} ` : ''}${task.name}` `` | a **single space**, by construction |
| vitest 5.0.0 | `task.fullTestName` | `createTaskName(names, separator = " > ")` |

Both in `interpretTaskModes`; in vitest 5 the line is
`if (namePattern && !t.fullTestName.match(namePattern)) t.mode = "skip"`
(`vitest/dist/task-utils.js`).

So for any test that lives inside a `describe`, the runner's space-joined name no
longer matches vitest's `" > "`-joined `fullTestName`. Every test in the file is
set to `skip`, the run completes with no test results at all, and Stryker — with
nothing failing — records the mutant as survived.

Driving the vitest 5 node API exactly as the runner does, against the sandbox of
a real Stryker run (`ArithmeticOperator` on `src/utils/formatting.ts:167`):

| `testNamePattern` | tests observed | file state | mutant |
| --- | ---: | --- | --- |
| none | 12 → 1 failed | `fail` | detected |
| `formatSlaBlock states the exact number of minutes remaining` (what the runner builds) | **0** | `skip` | **undetected** |
| `states the exact number of minutes remaining` | 1 → failed | `fail` | detected |
| `formatSlaBlock > states the exact number of minutes remaining` | 1 → failed | `fail` | detected |

That also accounts for the *shape* of the numbers, not just their direction: a
mutant planned with **no** test filter — a static mutant, or one with no coverage
information — still runs the whole suite and is killed normally. Those are the
`Killed: 7`. Every mutant that gets a per-test filter escapes.

Ruled out, all verified working on vitest 5:

- mutant activation (`provide`/`inject` of `activeMutant`, both `static` and
  `runtime` activation);
- the setup-file injection via `project.config.setupFiles`;
- the `suite.meta` round-trip that carries `mutantCoverage` and `hitCount` back;
- `ctx.state.getFiles()` / `errorsSet` — the state API the runner reads is
  unchanged.

Only the name filter is broken.

## Why CI is unlikely to catch this

A test **not** inside a `describe` produces a single-part name, where the
separator never appears — so a flat fixture passes under both versions. A
regression test for this needs at least one `describe` level around the test
whose name the filter is built from.

## Possible fixes

1. **Join with the separator vitest uses.** The runner already branches on the
   vitest version (`isGreaterThanVitest4Point1`), so the narrow fix is to pick
   `' > '` for vitest ≥ 5 and `' '` below it, in `collectTestName()` or at the
   point the regex is assembled. Smallest change; keeps the name-matching
   coupling that caused this.
2. **Filter by test id instead of by name.** `interpretTaskModes` also honours a
   `testIds` set, and vitest 5's test specifications carry `testIds`. Capturing
   each task's vitest id during the dry run and filtering on ids would drop the
   regex — and with it the name-escaping and separator coupling — entirely. More
   work, but this class of breakage stops recurring.
3. **Meanwhile, tighten the peer range** to `vitest: ">=2.0.0 <5.0.0"`, so
   installing vitest 5 warns instead of silently producing wrong reports. This is
   the part that turned a compatibility gap into a silent one.

#6214 takes route 1, extended to `toRawTestId` so the names used for coverage
recording and for filtering stay the same string. Route 3 is not covered by it,
and is the one that would have made this loud rather than silent — worth raising
on the issue if it stays unaddressed once the fix lands.

## Reproducing

Anything with a `describe` around the mutated code's test reproduces it. In this
repository:

```sh
pnpm test:mutation --mutate 'src/utils/formatting.ts:165-168'
# vitest 4.1.11 → Killed 3, Survived 0
# vitest 5.0.0  → Killed 0, Survived 3

pnpm test:mutation:canary   # two-line fixture, ~3 s: passes on 4.1.11, fails on 5.0.0
```
