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

> **The CI design in this section is not wired yet.** What shipped with this
> decision is `stryker.config.mjs` and the `pnpm test:mutation` script — there is
> no mutation job in `.github/workflows/`. Everything below about jobs, caches
> and gates is the design these measurements argue for, recorded so the job can
> be built against it. Read it as a specification, not a description.

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
is invisible to it: `tests/setup.ts`, `tests/msw-handlers.ts` (which defines
every mocked Zendesk response the assertions rest on), `tests/integration/harness.ts`.
Edit one of those and verdicts get replayed against the old fixtures.

Outside `tests/` it covers `pnpm-lock.yaml` and `package.json` (dependency and
devDependency versions), `stryker.config.mjs`, `vitest.config.ts`, `.nvmrc` and
the Node version, environment variables the suite reads through `src/config.ts`,
and snapshot files should the suite ever grow any. The point of stating it as an
allowlist is that this enumeration cannot be relied on to stay complete.

Because that hazard has no automatic guard, **`incremental` is deliberately not
enabled in `stryker.config.mjs`**: `pnpm test:mutation` is always a trustworthy
cold run, and the speed-up is an explicit `--incremental` on the invocation that
knows its baseline is good. Correctness by default, speed on request.

For the CI design that means the `push: main` job must run `--force` when the
lockfile, the Stryker config or the Node version moved in that push, and plain
`--incremental` otherwise — the cache key should include hashes of those three
inputs so a change misses the cache rather than reusing it.

**Two rules the CI wiring depends on**, both easy to get wrong:

- **Only the `main` job writes the incremental baseline.** A PR job runs with a
  narrow, diff-scoped `--mutate`; if it wrote back to the shared cache it would
  publish a truncated baseline for every subsequent PR.
- **The PR job scopes `--mutate` to the diff**, not just for speed but as a
  bound. If the cache is cold (7-day eviction), a full-scope run would blow the
  job timeout; a diff-scoped one stays in the minutes.

`break` is left `null` in `stryker.config.mjs`: this global baseline is
advisory. A gate belongs on the score *of the diff* — "the mutants this PR
introduces or touches must be killed" — not on a repo-wide number that starts in
the seventies.

## 5. Scope: why `src/tools/**` is out for now

`mutate` covers `src/auth`, `src/client`, `src/routing`, `src/utils` and
`src/config.ts` — the logic code, where a surviving mutant is a real test gap.

`src/tools/**` is excluded deliberately. It holds 151 `.describe()` calls across
3 770 lines, and Stryker's `StringLiteral` mutator empties each one, producing a
survivor per description that means nothing about test quality. Bringing that
directory in needs `excludedMutations: ["StringLiteral"]` scoped to it, which is
a follow-up, not a prerequisite.

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
pnpm test:mutation                  # full configured scope, cold — always trustworthy
pnpm test:mutation -- --mutate 'src/utils/**/*.ts'   # one directory
pnpm test:mutation -- --incremental # reuse the baseline (see the staleness table in section 4)
pnpm test:mutation -- --incremental --force   # rebuild the baseline from scratch
```

The HTML report lands in `reports/mutation/index.html`; the incremental baseline
next to it. Both are git-ignored.
