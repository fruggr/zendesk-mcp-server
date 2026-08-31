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

**Stryker does not run on TypeScript 7 out of the box.** It fails before the
first mutant:

```text
ERROR Stryker TypeError: ts.parseConfigFileTextToJson is not a function
    at TSConfigPreprocessor.rewriteTSConfigFile
```

The cause is a soft dependency: `@stryker-mutator/core` does a bare
`await import('typescript')` — the package is *not* in its `dependencies` — and
calls `ts.parseConfigFileTextToJson`, which TS 7's experimental JS API does not
expose. Upstream tracking issue:
[stryker-js#6110](https://github.com/stryker-mutator/stryker-js/issues/6110)
(open, 1/4 tasks, no assignee; re-checked on the 10.0.0 bump — `core` still ships
`src/sandbox/ts-config-preprocessor.ts` and still calls the missing function, so
the sentinel below stays).

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
> script. The gate runs on every pull request and **does block a merge**: the
> ruleset on `main` lists `Changed lines` as a required status check.

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

That extrapolated badly, and the number it produced is worth keeping as a
warning. Projecting to all of `src/` gave ~7 400 mutants ≈ 65 min, and
`mutation.yml` was sized against it. Two things made it wrong: the scope that
shipped ([§5](#5-scope-and-how-string-mutants-are-treated)) leaves out
`src/tools/**`, so it is **2 043 mutants**, more than three times fewer; and CI
runs about twice the mutants per second of the 4-core figures above.

Two cold-run figures, and they are not interchangeable. **Locally on 4 cores**,
the whole scope is **13 min 7 s** (measured on #203's branch, 2 043 mutants).
**In CI**, the `baseline` job read **6–10 min** — 6 min 22 s on `ca28fad`,
9 min 49 s on the dependency bump before it — but over **1 417** mutants, and
before both the Stryker 10 bump ([§8](#8-the-1000-bump-and-the-one-mutator-it-adds)
has the +35 and what it cost) and `src/utils/formatting.ts` re-entering the scope
with #203. Scaled by mutant count that band becomes roughly 9–14 min, which the
baseline job's `timeout-minutes: 45` still clears with room; the figure to trust
is the first `main` baseline after #203 merges, not this extrapolation. A **warm**
run is 45 s to 2 min.

Those are the `baseline` job, which mutates the **whole** scope. The `Changed
lines` gate a PR actually waits on mutates only the lines the diff touched, so it
sits well under a minute (30 s on this document's own PR) — a different
measurement from the 45 s to 2 min above, not a contradiction of it. That is what
makes a PR-time gate viable rather than a nightly one. A gate that only reports
after merge reports too late. Re-measure if `src/tools/**` ever enters the scope —
that is the change that would make 65 min real, and it would overrun the
baseline job's `timeout-minutes`, which is sized for the scope above.

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
baseline bought for nothing.

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
([§5](#5-scope-and-how-string-mutants-are-treated)).

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

- **StrykerJS has no git-aware scoping.** Nothing in its 10.0.0 schema is
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
  against 10.0.0 today. It scopes by *file*, and #2843's own author describes the
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

## 5. Scope, and how string mutants are treated

`mutate` covers `src/auth`, `src/client`, `src/routing`, `src/utils` and
`src/config.ts` — the logic code, where a surviving mutant is a real test gap.

**A label-heavy file does not merely score badly — it booby-traps the gate.**
Because the gate fails a PR on a survivor in a line that PR changed, a file whose
survivors are mostly label strings makes every future edit to those lines fail CI
for debt the author did not create. The author's only ways out are to write
assertions for someone else's code or to stop touching the file, and a gate that
punishes unrelated work is a gate that gets switched off. So bringing a file into
scope is a decision to do its assertion work *first*:

| Excluded | Why | Owner |
| --- | --- | --- |
| `src/tools/**` | `.describe()` calls, each emptied by `StringLiteral` into a survivor that says nothing about test quality | [#212](https://github.com/fruggr/zendesk-mcp-server/issues/212) |

Excluded from *mutation* only: it still runs under `pnpm test` and still counts
towards the coverage thresholds.

`src/utils/formatting.ts` was excluded here until #203, which brought it in at
**zero escaped mutants**. That is the bar, and it is not a round-number
aesthetic: re-arming the gate on a file with any residue leaves a mine on each
line that carries one, which is the trap the exclusion existed to avoid. Getting
there is also what corrected the reasoning below.

### The `StringLiteral` question, decided on measurement

The tempting rule — "`StringLiteral` survivors are label noise, exempt them" — is
wrong, and #203 measured how wrong. On `581c958` that file had 173 escaped
mutants, 102 of them `StringLiteral`. Splitting those 102 by what the string
actually *is*:

| Form | Count | What it is |
| --- | ---: | --- |
| `'…'` → `''` | 73 | a label or separator emptied — including every trailing `.join('\n')` |
| `''` → a non-empty marker | 29 | the **suppressed-line branch of a ternary** |

The second group is not prose at all. It is the assertion "this line must be
*absent* from the output", and no `not.toContain` can make it: Stryker replaces
the `''` with a marker, the line appears, and the negative assertion still
passes. The same blind spot covers two more forms that are not `StringLiteral` —
a dropped `.filter(Boolean)` (the output gains a blank line) and an emptied
separator inside a joined list.

So the axis is not the mutator, and it is not the file. **It is what the string
does**, and there are four roles:

1. **Behavioural** — anything the code branches on, or that travels to a wire,
   protocol or API: dispatch keys, `case` labels, sentinels, algorithm and
   encoding identifiers, HTTP header names and values, OAuth parameters and
   scopes, error codes, env-var names, escaping replacements, data-mapping keys.
   A survivor here is a missing test, and Stryker classing it as `StringLiteral`
   is an accident of the mutator's implementation. **Assert, never disable.**
2. **Structural** — the `''` arm that suppresses an output line, and its
   non-string cousins (`filter(Boolean)`, list separators). **Assert**, with an
   input where the line *is* suppressed.
3. **Output prose read by an agent or a user.** Also assert: an exact-output
   assertion costs a `vitest -u` on a pre-filled `toMatchInlineSnapshot`, so the
   maintenance argument for exempting cosmetic prose does not survive contact
   with the tooling. Measured on one formatter — two snapshots took its region
   from 6 killed / 15 escaped to 21 killed / 0 escaped, with no directive; the
   block-scoped disable scored 36.36 % and left the seven logic mutants needing
   *the same two inputs* anyway.
4. **Internal diagnostics** — log event names, debug payload keys. Disable with a
   reason, unless a test asserts the event name as an observability contract, in
   which case it is role 1.

### Mechanism, and what it cannot do

`mutator.excludedMutations` stays unused: it is global-only, so it would exempt
files nobody has looked at yet, including files added later.

A directive is `// Stryker disable next-line <Mutator>[,<Mutator>]: <reason>`, or
a `disable`/`restore` pair around a region. **Never at file scope** — every file
worth arguing about mixes roles, and a file-scoped `StringLiteral` disable in
`formatting.ts` would have silently exempted its dispatch keys and sentinels
along with its labels.

Every disable names the role it claims, so a reviewer can challenge the
classification; an unexplained disable is indistinguishable from hiding a gap.

**And it cannot target one mutant among several of the same mutator on a line.**
The equivalent mutant is typically the whole-condition `ConditionalExpression`
while its siblings on the same line are killed, so a line-level waiver takes them
with it. Splitting a guard into two statements isolates a clause; hoisting a
condition into a named `const` does *not*, because Stryker emits the
whole-conjunction mutant wherever the expression sits. Which is why the first
question is never "how do I scope the waiver" but **"is this mutant actually
equivalent"**.

#203 got that wrong twice before getting it right, and the pattern is worth
naming. Two mutants in `renderAuditValue` looked equivalent because every
*reachable* input produced identical output: emptying the `value === ''` arm, and
forcing the SLA-metric test true. Both arguments rested on the **caller** — the
audit name maps never carry key 0, the Zendesk API never sends an array with an
own `minutes` property — while the guards live in a function whose signature
promises neither. `AuditNames` is a plain `Map<number, string>`; `value` is
`unknown`. Each mutant was killable by one test asserting the guard's own
contract, and the file now needs **no directive at all**.

So: when a mutant looks equivalent, check whether the argument for that is a fact
about the *type* or a fact about *today's caller*. If it is the caller, the
mutant is marking an unasserted contract, and the assertion is the fix. A waiver
that also covers killed siblings is a last resort, acceptable only when the
comment says so and the assertions behind those siblings stay in place — only the
gate accounting is ever waived, never the test.

**The `!` ordering is load-bearing**, even with no negation left in `mutate`
today. Stryker resolves it as a sequence of set/unset operations rather than two
independent lists (`project-reader`, `resolveFileDescriptions`), so a negation
only excludes what an *earlier* pattern included. `scopeMatcher` in
`scripts/mutation-scope.mjs` mirrors that exactly, and has to: the gate hands its
ranges to `--mutate`, which **replaces** the configured scope rather than
intersecting with it. A `patterns.some(...)` that ignored negations would have
let the gate mutate an excluded file anyway — the exclusion defeated in the one
place it has to hold. Pinned in `tests/unit/mutation-scope.test.ts`, and the next
exclusion will depend on it.

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

## 7. Publishing the score, so the trend outlives the run

The HTML report expires as a CI artifact (30 days baseline, 7 for a PR) and the
incremental cache is *current state*, overwritten on every push to `main`. So
"where was `src/auth` a month ago" had no answer. The
[Stryker dashboard](https://stryker-mutator.io/docs/General/dashboard/) keeps a
trend line per branch and hosts the full report; its reporter ships inside
`@stryker-mutator/core`, so this adds no dependency.

### `reportType: 'full'` — decided, not inherited

`full` uploads the report with its **source snippets** to a third party;
`mutationScore` sends only the number. `full` wins because it makes the survivor
table browsable per file online, which is most of what a hand-maintained
per-area table is for. The disclosure question has a short answer here: the
source is already public on GitHub and npm. In a private repo the choice would
go the other way — so if a private or credential-bearing file ever enters the
`mutate` scope, revisit this.

It is also Stryker's default, written out anyway because a default is not a
decision. `project` and `version` stay unset: `GithubActionsCIProvider` derives
them from `GITHUB_REPOSITORY` and `GITHUB_REF` (`refs/heads/main` → `main`,
`refs/pull/7/merge` → `PR-7`).

**`module` is not used.** A trend line per scoped area needs a separate run per
area, multiplying the cold baseline. The per-*file* breakdown comes free with a
`full` upload, which is the part actually wanted.

### Why the reporter is gated on the key

Nothing guards the upload: `DashboardReporterClient` PUTs whether or not
`STRYKER_DASHBOARD_API_KEY` is set, and the only precondition — that `project`
and `version` resolve — always holds on Actions.

The resulting 401 does **not** fail the run; `DashboardReporter.update()` catches
it and logs `Could not upload report.` (measured on 9.6.1 with a dead `baseUrl`,
exit code 0 — an earlier reading assumed the throw escaped, so re-check on a
major bump; re-read on 10.0.0, `update()` still wraps the whole call in a
`try`/`catch` that only logs). The gate earns its place for two quieter reasons: a red `ERROR` on
every fork PR is a false alarm in the one job people read for real alarms, and a
PR run that *did* have a key would publish its diff-scoped report — a truncated
entry corrupting the trend.

So the config enables the reporter exactly when the key exists, and the workflow
hands the secret to the `Full scope` step alone. A PR run, fork or not, has no
key, therefore no reporter, therefore no request — the same rule the incremental
cache follows (*only the baseline writes*), and structural rather than
remembered. Local runs never publish either: without a key there is no reporter,
and with one `determineCIProvider()` finds no `GITHUB_ACTION` and stops before
the PUT.

### One-time setup

The API key cannot be minted from CI. A human enables the project once at
<https://dashboard.stryker-mutator.io>, picks the `fruggr` organisation and
`zendesk-mcp-server`, then copies the key into the **repository secret**
`STRYKER_DASHBOARD_API_KEY` (the Secrets tab, not Variables — `${{ secrets.X }}`
does not read the other one). The next push to `main` publishes.

The baseline log tells you which of three states you are in: no
`DashboardReporter` line at all means no key reached the run; `PUT report to …`
followed by `Could not upload report.` means the key is wrong; `PUT report to …`
alone means it worked.

#### If the account picker offers only your personal account

Expect this on the first attempt — and it is not a missing feature.
Organisation repositories are supported: the backend has a dedicated route
(`GET /organizations/:name/repositories` → `GET /orgs/{login}/repos?type=member`),
enabling a project needs only **push** permission, and the reference deployment
publishes `github.com/stryker-mutator/stryker-js`, itself an organisation repo.

The picker is `GET /user/orgs`, which GitHub documents as listing *"only
organizations that your authorization allows you to operate on in some way"*. A
missing organisation is an OAuth grant that was never given, not a permission on
the repository. The dashboard is a **classic OAuth App** (`user:email read:org`,
so public repositories only), which means an organisation with OAuth App access
restrictions hides itself until an owner approves it.

Fix it at <https://github.com/settings/applications> → **Authorized OAuth Apps**
→ Stryker Dashboard → **Organization access**:

| The `fruggr` row shows | What to do |
| --- | --- |
| **Grant** | you are an owner — click it |
| **Request** | request it; an owner grants at *fruggr → Settings → Third-party Access → OAuth app policy → Review → Grant access* |
| green check | already granted — the stored token predates it, so sign out and back in |

Signing out and back in matters in every case: the backend stores the access
token at login, so a later grant never reaches the token already on file. If it
still fails, revoke the app and re-authorise — the consent screen offers the
organisation directly.

If an owner declines there is no workaround worth having: the key is minted per
project, and the only fallback (pinning `dashboard.project` to a personal fork)
puts the trend and the badge under someone's personal account.

## 8. The 10.0.0 bump, and the one mutator it adds

Recorded here because the interesting half of a major bump is what it does to
the *numbers*, and that is measurable exactly once — before the baseline moves.

Only one of the four upstream headlines touches this repo:

| Upstream change | Effect here |
| --- | --- |
| Requires Node.js 22+ | None. `.nvmrc` is 24 and every job that installs dev dependencies reads it. `smoke-node20` never installs them — it runs the packed tarball — so the published `engines: >=20` is untouched. |
| `empty-expression-mutator` | +37 mutants. The subject of the rest of this section. |
| Babel 8 | None measurable: mutant counts per mutator are byte-identical to 9.6.1 outside the new one (17 mutators compared). |
| Partial incremental report on unexpected exit | Latent. The baseline job still saves only `if: success()` — a partial baseline is exactly the stale-verdict problem [section 4](#the-baseline-can-go-stale-and-stryker-will-not-tell-you) exists to prevent, so the feature stays unused until there is a reason. |

The new mutator is registered as **`CallExpression`** (not, as its package name
suggests, `EmptyExpression` — that is the name to pass to `excludedMutations`).
It empties a call: `foo()` → `void 0` in expression position, and a whole
`foo();` or `throw new Foo();` statement → `;`. It carries a `filter` that only
keeps the mutant when the call's *entire subtree* produced no other mutant, which
is what keeps it rare — measuring it in isolation, with every other mutator
excluded, inflates it from 37 mutants to 91.

Measured on this scope. The middle column is the bump on its own; the right one is
after the assertion work below, which shipped in the same PR:

| | 9.6.1 | 10.0.0 | + assertions |
| --- | ---: | ---: | ---: |
| Mutants | 1417 | 1454 | 1452 |
| Score (total) | 82.64 % | 82.39 % | **83.61 %** |
| Score (covered) | 84.24 % | 84.19 % | **85.01 %** |

So the mutator costs a quarter of a point until its findings are acted on, and
pays back four times that once they are. The `auth` namespace moves 58.42 % →
62.87 %, with `browser-oauth.ts` and `token-persistence.ts` both 53 % → 59.26 %.

Of the 37 new mutants, 27 were detected (26 killed, 1 timeout) and **10 escaped —
every one of them in `src/auth`**. Nine were in `browser-oauth.ts`, the only file
whose score fell before the assertions landed (53.14 % → 52.36 %); every other
file held or gained.

The mutator was **kept enabled**, against the [section 5](#5-scope-and-how-string-mutants-are-treated)
booby-trap test, because not one of its survivors was role-3 prose. Every single one
was an unasserted teardown or error path — which is the case for the mutator, so
the ten are worth listing individually:

| Escaped | The call, and what nothing asserted about it | Outcome |
| --- | --- | --- |
| `browser-oauth.ts:180-181` | `clearTimeout` + `callbackServer.close()` on every terminal callback path — nothing checked the port is released or the 5-minute timer cancelled | test added |
| `browser-oauth.ts:232` | `res.writeHead(404)` — the non-`/callback` request path was never exercised at all | test added |
| `browser-oauth.ts:260-262` | the post-`listen` `error` handler's whole teardown (clear, close, reject token) — unreachable from outside, so untested | test added |
| `browser-oauth.ts:314` | `callbackServer.close()` in the timeout handler — the existing timeout test asserted the log and the rejection, not the port | assertion added |
| `token-persistence.ts:74` | `chmodSync(dir, 0o700)` — the file's 0600 was asserted, the directory's mode never | test added |
| `browser-oauth.ts:246` | `clearTimeout(authTimeout)` in `onStartError` | **line deleted** |
| `browser-oauth.ts:317` | `authTimeout.unref()` | `Stryker disable next-line` |

Two of those deserve their own note, because neither was a missing test:

- **`:246` was dead code, and the mutant is how we found out.** `authTimeout` is
  only assigned inside the `listen` callback, which `off`s `onStartError` before
  it gets there — so whenever `onStartError` runs, `authTimeout` is still
  `undefined` and `clearTimeout(undefined)` does nothing. No test could have
  killed that mutant, because there was no behaviour to observe. The line is gone.
- **`:317` is a genuinely equivalent mutant in-process.** Dropping `unref()` only
  changes whether a pending timer holds the event loop open, and a test process
  is kept alive by the runner regardless. It is load-bearing in production — a
  finished CLI run would otherwise linger for up to five minutes — so the call
  stays, with a `// Stryker disable next-line CallExpression` recording why.

Reaching the post-`listen` error handler needed the callback server instance,
which the flow never hands out. `tests/unit/auth/browser-oauth.test.ts` now wraps
`node:http`'s `createServer` to record it — that also replaced the "is the port
closed?" probe, since `server.listening` is observable where a refused connection
over loopback is indistinguishable from a slow one.

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
