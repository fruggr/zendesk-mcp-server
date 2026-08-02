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
answers "if this line were wrong, would a test notice?". On `src/utils` the two
answers are 26 points apart:

| | `src/utils` |
| --- | ---: |
| Line coverage | 98.58 % |
| Branch coverage | 83.96 % |
| **Mutation score (total)** | **71.59 %** |

Of 982 mutants injected into `src/utils`, 47 (4.8 %) were never reached by any
test — that part coverage already reports. The other **232 (23.6 %) were
executed by the tests and went undetected**, which no coverage metric can see.

The most eloquent single file is `logger.ts`: **100 % branch coverage**, 66.28 %
mutation score. The strictest classical metric is maxed out and has nothing
left to say about it.

## 2. Why StrykerJS and not something else

There is no second option in JS/TS. StrykerJS is the only actively maintained
mutation testing framework for this ecosystem; the alternatives that surface in
a search are either abandoned (mutode, mutant.js — last released ~2019) or are
test runners misfiled as alternatives. The remaining live approach — having an
LLM agent generate mutants — exists to work around cases Stryker cannot handle
(Vitest browser mode), which is not our situation.

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
the CI job's `timeout-minutes: 10`. With the incremental baseline restored, a
normal PR costs well under a minute, which is what makes a PR-time gate viable
rather than a nightly one. A gate that only reports after merge is a gate that
reports too late.

> **Note on Vitest and incremental mode.** Stryker's per-test change detection
> is fine-grained for Jest and CucumberJS only. For Vitest it works per *file*:
> touching a test file marks all of its tests as changed. That is why one edited
> test file re-runs 102 mutants rather than a handful. It costs time, never
> correctness.

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

What changes is where the *next* effort goes. Line and statement coverage are at
97–98 % against thresholds of 94–95 — the remaining points are defensive
guards, expensive to reach and low-yield. Branch coverage (83.34 % real, 77
threshold) is the classical metric closest to what mutation testing measures and
still has room: `users.ts` at 50 %, `reload.ts` at 57.14 %,
`browser-oauth.ts` at 67.74 %. Past that, the 232 survivors are where the new
information is.

## Appendix — reproducing

```sh
pnpm test:mutation                  # full configured scope, incremental
pnpm test:mutation -- --force       # ignore the baseline, re-run everything
pnpm test:mutation -- --mutate 'src/utils/**/*.ts'   # one directory
```

The HTML report lands in `reports/mutation/index.html`; the incremental baseline
next to it. Both are git-ignored.
