# Mutation testing: StrykerJS, and the TypeScript 7 workaround it needs

> **Build documentation, not user documentation.** This records a toolchain
> decision and the measurements behind it, for maintainers. Nothing here affects
> how the MCP server behaves for a client. User-facing docs live one level up in
> [`docs/`](../).

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-08-02 |
| **Question** | Line coverage sits at 97.5 % and its ratchet is close to saturation. What tool measures whether the tests actually *assert* anything, and can it run on this stack? |
| **Answer** | **StrykerJS** (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`). It works here, but only past a TypeScript 7 incompatibility — see [§3](#3-the-typescript-7-workaround). |

Every number below was measured on this repository, on the 4-vCPU CI container.

---

## 1. TL;DR

`vitest run --coverage` answers "was this line executed?". Mutation testing
answers "if this line were wrong, would a test notice?". Measured on `src/utils`
**before** any test was written for this decision, the two answers were 27
points apart:

| `src/utils`, baseline (2026-08-02, pre-change) | |
| --- | ---: |
| Line coverage | 98.58 % |
| Branch coverage | 83.96 % |
| **Mutation score (total)** | **71.59 %** |

Of 982 mutants injected into `src/utils`, 47 (4.8 %) were never reached by any
test — that part coverage already reports. The other **232 (23.6 %) were
executed by the tests and went undetected**, which no coverage metric can see.

The most eloquent single file was `logger.ts`: **100 % branch coverage**, 66.28 %
mutation score. The strictest classical metric maxed out, with nothing left to
say about the file.

**After** the round of test work that shipped with this decision, `src/utils`
stands at **76.78 %** (187 survivors, 41 unreached), with `pagination.ts` at
100 %. The per-file breakdown lives in the PR that introduced this document;
the number to re-measure against is the 71.59 % baseline above.

> Every percentage in this document is `src/utils` alone, the scope the
> measurements were taken on. Repo-wide coverage is one `pnpm test:coverage`
> away and is not restated here.

## 2. Why StrykerJS and not something else

Surveying the field on **2026-08-02**, no comparable alternative turned up. The
named alternatives are either long abandoned (mutode, mutant.js — last releases
~2019) or test runners misfiled as mutation tools in comparison listicles. The
one live *approach* that is not Stryker — having an LLM agent generate the
mutants — exists to work around cases Stryker cannot handle (Vitest browser
mode), which is not our situation.

So the choice was made on fit rather than on a shortlist:

- a **first-party Vitest runner**, so the existing suite and MSW setup run
  unchanged;
- **per-test coverage analysis**, which is what keeps a mutant's test set small
  enough for the run times in [§4](#4-cost-and-why-the-gate-can-live-in-the-pr);
- **incremental mode**, without which a PR-time gate is not affordable here;
- a **report format** (`mutation-testing-report-schema`) that is consumable
  without the vendor's dashboard.

Treat the "no alternative" half as time-sensitive and re-check it if this
decision is ever revisited; the fit criteria above are the durable part.

## 3. The TypeScript 7 workaround

**Stryker 9.6.1 does not run on TypeScript 7 out of the box.** It fails before
the first mutant:

```text
ERROR Stryker TypeError: ts.parseConfigFileTextToJson is not a function
    at TSConfigPreprocessor.rewriteTSConfigFile
```

The cause is a soft dependency: `@stryker-mutator/core` does a bare
`await import('typescript')` — the package is *not* in its `dependencies` — and
calls `ts.parseConfigFileTextToJson`, which TS 7's experimental JS API does not
expose. Upstream tracking issue:
[stryker-js#6110](https://github.com/stryker-mutator/stryker-js/issues/6110)
(open, 0/4 tasks, no assignee as of this writing).

Three routes were considered:

| Route | Verdict |
| --- | --- |
| pnpm scoped override to feed Stryker the `typescript-legacy` (TS 6) alias | **Impossible.** `overrides` redirect *declared* dependencies; `typescript` is undeclared here, so there is nothing to override. |
| `inPlace: true`, which skips the preprocessor | **Rejected.** It mutates the real source files instead of a sandbox copy — a crashed run leaves the working tree corrupted. |
| **Point `tsconfigFile` at a file that does not exist** | **Applied.** |

The preprocessor exists for one job: rewriting relative `extends` /
`references` paths that would fall outside the sandbox once the project is
copied. Our `tsconfig.json` extends *package names*
(`@tsconfig/node20`, `@tsconfig/strictest`) and declares no project references,
so it has nothing to rewrite. When `project.files.get()` misses, the `typescript`
import never happens and the run proceeds. The cost of the workaround here is
therefore zero, and it is one line in `stryker.config.mjs`.

**`@stryker-mutator/typescript-checker` is deliberately not installed.** It hits
the same wall, far deeper into the compiler API. Its job is to discard mutants
that would not compile; without it those mutants simply run (Vitest transpiles
via esbuild without type-checking) and land as extra noise. Acceptable — and
revisitable when #6110 ships.

A second, smaller adjustment: **plugin auto-discovery fails under pnpm.** Stryker
globs `node_modules/@stryker-mutator/*` and comes up empty against the symlinked
layout, reporting `Cannot find TestRunner plugin "vitest"`. The runner is listed
explicitly in `plugins` instead.

## 4. Cost, and why the gate can live in the PR

> **This is wired.** `.github/workflows/mutation.yml` implements it, backed by
> `stryker.config.mjs`, `scripts/mutation-scope.mjs` and the `pnpm test:mutation`
> script. The gate runs on every pull request but **does not block a merge until
> branch protection marks the `Changed lines` check required** — flip that once
> one real PR has been through it.

The Vitest runner only supports `threads: true` and sets the pool itself,
overriding this repo's default (`forks`). The suite passes under both — 10.2 s
against 9.0 s — so nothing else had to change.

A cold run is expensive; incremental runs are not. Measured on `src/utils`
(1 057 lines, 982 mutants, 4 cores):

| Scenario | Mutants re-run | Wall clock |
| --- | ---: | ---: |
| Cold | 982 / 982 | **8 min 33 s** |
| `--incremental`, nothing changed | 0 | **17 s** |
| `--incremental`, one source file changed | 12 | **30 s** |
| `--incremental`, one *test* file changed | 102 | **47 s** |

Extrapolated to all of `src/`, a cold run is ~7 400 mutants ≈ 65 min — well past
the existing CI job's `timeout-minutes: 10`. With the incremental baseline
restored, a normal PR costs well under a minute, which is what makes a PR-time
gate viable rather than a nightly one. A gate that only reports after merge is a
gate that reports too late.

> **Note on Vitest and incremental mode.** Stryker's per-test change detection
> is fine-grained for Jest and CucumberJS only. For Vitest it works per *file*:
> touching a test file marks all of its tests as changed. That is why one edited
> test file re-runs 102 mutants rather than a handful. *This particular
> coarseness* only ever re-runs more than strictly needed, so it costs time, not
> correctness — which is **not** true of incremental mode in general, see below.

### The baseline can go stale, and Stryker will not tell you

Incremental mode diffs **mutated sources and test files, and nothing else**.
[Upstream documents](https://stryker-mutator.io/docs/stryker-js/incremental/)
that changes to dependencies (including devDependencies), environment variables
and snapshot files are not detected. Neither is a change to
`stryker.config.mjs` itself. Any of those can silently invalidate a reused
verdict: a mutant recorded as `Killed` against an old version of a library is
replayed as `Killed` without being re-run.

So a stale baseline is a *correctness* problem, not just a stale-number problem,
and it has to be invalidated deliberately. Stated as an allowlist, because an
enumeration of undetected inputs is one upstream change away from being wrong:

| Diff since the baseline | Action |
| --- | --- |
| **Confined to `src/**` and `tests/**/*.test.ts`** | `--incremental` is sound |
| **Anything else** | `--force` — rebuilds the baseline |

"Anything else" is deliberately broad, and it includes files *inside* `tests/`.
Stryker diffs the **test files it discovered**, so the suite's shared scaffolding
is invisible to it — in practice every non-`*.test.ts` file under `tests/`:
`tests/setup.ts`, `tests/msw-handlers.ts` (which defines every mocked Zendesk
response the assertions rest on), and the integration scaffolding (`harness.ts`,
`core-scenarios.ts`, `stdio-harness.ts` — `core-scenarios.ts` alone holds the
shared assertions every transport is checked against). Edit one of those and
verdicts get replayed against the old fixtures.

Outside `tests/` it covers `pnpm-lock.yaml` and `package.json` (dependency and
devDependency versions), `stryker.config.mjs`, `vitest.config.ts`, `.nvmrc` and
the Node version, environment variables the suite reads through `src/config.ts`,
and snapshot files should the suite ever grow any. The point of stating it as an
allowlist is that this enumeration cannot be relied on to stay complete.

Because that hazard has no automatic guard, **`incremental` is deliberately not
enabled in `stryker.config.mjs`**: `pnpm test:mutation` is always a trustworthy
cold run, and the speed-up is an explicit `--incremental` on the invocation that
knows its baseline is good. Correctness by default, speed on request.

### How CI enforces that, without anyone having to remember

**The cache key carries the invalidation.** The composite action
`.github/actions/mutation-baseline` hashes exactly the inputs from that "anything
else" list into the cache-key prefix (`pnpm-lock.yaml`, `stryker.config.mjs`,
`vitest.config.ts`, `tests/setup.ts`, `tests/msw-handlers.ts`, the
`tests/integration/` scaffolding, `.nvmrc`). Change one and no entry matches; no
baseline on disk means Stryker runs cold. The rule is structural rather than a
conditional `--force` somebody has to keep in sync with this document.

That hash is **the only such list in the setup**, and both jobs get it from the
one composite action — they have to agree on cache identity, and only one of them
writes. A `paths:` filter on the `push` trigger would have been a second list of
"what can change a verdict", kept in sync by hand, with asymmetric failure modes:
too broad wastes a few minutes of CI, one entry short leaves every later PR
restoring a stale baseline. So the trigger is unfiltered. What that filter would
have saved is the cheap run anyway — with the baseline restored, a push touching
nothing in scope is a dry run plus a report — and running on every push keeps the
entry warm against the 7-day eviction.

That equivalence is enforced by a unit test rather than by this paragraph,
because forgetting one is the silent failure the rule exists to prevent. The test
compares the hashed paths against every file under `tests/` — whatever its
extension, so a JSON fixture or an `.mjs` helper a suite reads at runtime cannot
slip through — with one deliberate exemption: `tests/functional/`. That directory
is the inter-LLM harness driven by hand through `/functional-testing`, and
`vitest.config.ts` loads only `tests/**/*.test.ts`, so nothing in it can change a
verdict. It also *must* stay exempt: the harness writes a report per scenario
run, and hashing those would discard the baseline on every recorded run — a cold
hour bought for nothing.

Note what is *absent* from the hash: `src/**` and `tests/**/*.test.ts`. That is
the point of it. Those are exactly what incremental mode does diff correctly, so
hashing them would discard the baseline on every commit and buy nothing. The list
grows only when a file appears that changes how the tests behave without being a
test file Stryker discovers — another setup file, another shared fixture or
harness, a runner config.

Two details that make that work, both easy to get wrong:

- **The key ends in the commit sha, and the fallback is the prefix.** Actions
  cache entries are immutable, so a fixed key would freeze the first baseline
  built for it forever. A per-commit key keeps every save fresh; the prefix
  `restore-keys` lets a PR fall back to main's latest — and that fallback is safe
  *only* because the inputs hash sits inside the prefix. A broader restore-key
  would reintroduce exactly the stale reuse this guards against.
- **Only the `baseline` job saves.** A PR job runs diff-scoped, so if it wrote
  back it would publish a truncated baseline for every later PR. It uses
  `cache/restore`, which cannot save, and the save step is `if: success()` so a
  failed or cancelled run never publishes a partial baseline.

**The gate is on changed lines, not changed files.** `scripts/mutation-scope.mjs`
turns the PR diff into Stryker line ranges (`file:start-end`, which `--mutate`
supports natively) and fails the job if a mutant inside them survived. File
granularity would judge a one-line change against every mutant in the file, so a
weakly-tested file would fail on its own history rather than on the PR. Measured
on `pagination.ts`: a two-line change produces 10 mutants instead of the 43 in
the whole file.

Line granularity narrows that problem but does not remove it — a line that
already carries a survivor still fails the PR that touches it. That residual is
what keeps label-heavy files out of scope until their assertion work is done
([§5](#5-scope-and-why-label-heavy-files-stay-out-of-it)).

The gate asks for **no survivors in the changed lines**, not a percentage: on a
handful of mutants a percentage is arbitrary (1 of 3 fails at 67 %, 1 of 10
passes at 90 %), while "a change you made went unnoticed by every test" is
predictable and explainable. For a genuinely equivalent mutant — an unreachable
defensive guard — the escape hatch is
`// Stryker disable next-line <mutatorName>: <why>` in the source, which puts the
reasoning in the diff where a reviewer sees it.

A PR that changes nothing inside the `mutate` scope skips the run entirely rather
than reporting a vacuous pass.

### What the gate cannot see

Line-range scoping has one blind spot, and it is a consequence of getting the
range check *right* rather than a bug left in.

Stryker mutates a construct only when the construct is **contained** in a
requested range — `locationIncluded` in the instrumenter's `syntax-helpers`, used
by `babel-transformer` — confirmed by measurement: asking for a single line in
the middle of a 20-line expression in `formatting.ts` instrumented **0 mutants**.
So an edit inside a construct larger than the edit produces nothing for the gate
to judge, and the gate says so explicitly rather than reporting a pass.

The alternative is worse. Judging mutants that merely *overlap* the changed lines
pulls in the ones Stryker deliberately did not instrument; under `--incremental`
those are replayed out of the baseline carrying **main's** verdicts
(`incremental-differ`: "old mutants that didn't run this time around"). A PR
touching one line of a 40-line expression would then fail on a survivor it never
created, and the author could not fix it except by writing tests for code they did
not write. A gate that fails for reasons the author cannot act on gets switched
off, so the blind spot is the better trade — stated, not hidden.

One related subtlety: `escapedMutants` compares lines where Stryker compares line
*and* column. That is equivalent only because `specsFor` emits whole-line ranges,
which Stryker widens to column 0 through `MAX_SAFE_INTEGER` (`project-reader`).
Narrowing a range to columns would require the comparison to grow columns too.

`break` is left `null` in `stryker.config.mjs`: this global baseline is
advisory. A gate belongs on the score *of the diff* — "the mutants this PR
introduces or touches must be killed" — not on a repo-wide number that starts in
the seventies.

### Why a script, and not a library

The fair question about `scripts/mutation-scope.mjs` is why any code is needed
here at all. Checked, not assumed:

- **StrykerJS has no git-aware scoping.** Nothing in its 9.6.1 schema is
  `since`, `range`, `diff` or `changedFiles` (verified against
  `node_modules/@stryker-mutator/core/schema/stryker-schema.json`). `--since` and
  `--with-baseline` are **Stryker.NET**, a different product with a different
  codebase — the single most common wrong turn when reading about this, and worth
  stating because search results and LLMs conflate the two freely.
- **Upstream knows.** [stryker-js#2843](https://github.com/stryker-mutator/stryker-js/issues/2843),
  "Generate mutant only for the changed lines in a range of commits", is the open
  request for exactly this, and it is marked stale. `--incremental` is the nearest
  built-in, and it answers a different question: it makes a *full* run cheap by
  reusing verdicts. It does not restrict the verdict to the diff, which is what a
  gate needs.
- **The one third-party option is unmaintained, and file-level.**
  `stryker-diff-runner` last published 2.3.11 in November 2022 — Stryker 6 era,
  against 9.6.1 today. It scopes by *file*, and #2843's own author describes the
  consequence: mutants are generated for the whole file, so the break threshold
  has to be turned off. That is the failure this gate exists to avoid; adopting it
  would mean writing the line-range half anyway, on top of an abandoned
  dependency.

What is left is genuinely small: turn a unified diff into `--mutate` line specs,
and read the JSON report (a published schema,
`mutation-testing-report-schema`) back. Both halves are a few lines of pure
function. What earns them a file of their own is that they are *testable* and
tested — `tests/unit/mutation-scope.test.ts` pins the hunk parsing and the range
arithmetic, because an off-by-one there would silently stop guarding a line and
nothing else in the suite would notice. The same logic inlined in YAML would be
none of those things.

Reconsider if #2843 ships: native line-range scoping would replace the first
half, and `thresholds.break` over a scoped run could replace the second.

## 5. Scope, and why label-heavy files stay out of it

`mutate` covers `src/auth`, `src/client`, `src/routing`, `src/utils` and
`src/config.ts` — the logic code, where a surviving mutant is a real test gap.

Two exclusions, both for the same reason and both temporary.

**A label-heavy file does not merely score badly — it booby-traps the gate.**
Because the gate fails a PR on a survivor in a line that PR changed, a file whose
survivors are mostly label strings makes every future edit to those lines fail CI
for debt the author did not create. The author's only ways out are to write
assertions for someone else's code or to stop touching the file, and a gate that
punishes unrelated work is a gate that gets switched off. So bringing a file into
scope is a decision to do its assertion work *first*:

| Excluded | Why | Owner |
| --- | --- | --- |
| `src/tools/**` | `.describe()` calls, each emptied by `StringLiteral` into a survivor that says nothing about test quality | needs `excludedMutations` or per-file directives |
| `src/utils/formatting.ts` | 171 escaped mutants, 58 % of them label strings; 42 distinct lines carry one | [#203](https://github.com/fruggr/zendesk-mcp-server/issues/203) |

Excluded from *mutation* only: both still run under `pnpm test` and still count
towards the coverage thresholds. `formatting.ts` also keeps the boundary tests
added alongside this decision — the exclusion defers the score, not the testing.

**The `!` ordering is load-bearing.** Stryker resolves `mutate` as a sequence of
set/unset operations rather than two independent lists (`project-reader`,
`resolveFileDescriptions`), so a negation only excludes what an *earlier* pattern
included. `scopeMatcher` in `scripts/mutation-scope.mjs` mirrors that exactly, and
has to: the gate hands its ranges to `--mutate`, which **replaces** the configured
scope rather than intersecting with it. A `patterns.some(...)` that ignored
negations would have let the gate mutate an excluded file anyway — the exclusion
defeated in the one place it has to hold. Pinned in
`tests/unit/mutation-scope.test.ts`.

## 6. What this replaces, and what it does not

Nothing. The coverage thresholds in `vitest.config.ts` stay exactly where they
are: 15 s of run time to catch "nobody tested this path at all" is cheap, and it
remains the right first filter.

What changes is where the *next* effort goes. Line and statement coverage sit a
few points above their thresholds, and those remaining points are defensive
guards — expensive to reach, low-yield. **Branch** coverage is the classical
metric closest to what mutation testing measures, and the one still carrying
real slack against its threshold; `pnpm test:coverage` names the weakest files
on any given day. Past that, the surviving mutants are where the new
information is.

## Appendix — reproducing

```sh
# Flags go straight after the script name — pnpm 11 forwards a `--` separator
# literally, and `stryker run -- --incremental` fails with "too many arguments".
pnpm test:mutation                                # full scope, cold — always trustworthy
pnpm test:mutation --mutate 'src/utils/**/*.ts'   # one directory
pnpm test:mutation --incremental                  # reuse the baseline (see the table in section 4)
pnpm test:mutation --incremental --force          # rebuild the baseline from scratch

# What the PR gate runs: derive the changed lines, mutate them, judge the report.
pnpm test:mutation:diff origin/main HEAD
pnpm test:mutation:summary                        # score of the last report, as Markdown
```

The HTML report lands in `reports/mutation/index.html`; the incremental baseline
next to it. Both are git-ignored.

The gate is **one command**, and CI runs the same one. It derives the changed
line ranges, mutates exactly those, and judges the report it just produced —
exiting 0 with a note when the diff touches nothing in the mutate scope, and 1
when a mutant escaped:

```sh
pnpm test:mutation:diff origin/main HEAD              # local
pnpm test:mutation:diff <base> <head> --incremental   # what CI runs
```

One command rather than three deliberately: the ranges stay in memory for the
whole operation, so the verdict necessarily describes the run that just
happened. Passing them through a file on disk would let a stale scope be paired
with a fresh report — a confident verdict about the wrong lines, with nothing
failing to say so.

Its parsing and range arithmetic are unit-tested in
`tests/unit/mutation-scope.test.ts`: an off-by-one there would quietly stop
guarding a line, which no other test would notice.
