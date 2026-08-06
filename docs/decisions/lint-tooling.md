# Lint tooling: per-edit hook, pre-commit gate, and why not Oxc

> **Build documentation, not user documentation.** This records a toolchain
> decision and the measurements behind it, for maintainers. Nothing here affects
> how the MCP server behaves for a client. User-facing docs live one level up in
> [`docs/`](../).

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-07-26 |
| **Applied in** | [#186](https://github.com/fruggr/zendesk-mcp-server/pull/186) |
| **Question** | Should this repo replace Biome with the Oxc toolchain (oxlint + oxfmt) to cut the cost of the `PostToolUse` lint hook on Android/Termux/PRoot? |
| **Answer** | **No.** The cost was two `types`-domain Biome rules, not the tool. See [§1](#1-tldr). |

Everything below is measured on this repository, not quoted from vendor
benchmarks. The reproduction script is `scripts/bench-lint-tooling.mjs`; the
method is in [Appendix A](#appendix-a--how-the-numbers-were-produced).

> **Measurement provenance — read before comparing numbers across sections.**
> The **stage tables** in §1, §6 and §7 are one dataset, re-measured on Biome
> 2.5.5 (the shipped version) once it cleared the release cooldown. Two things
> are deliberately *not* part of it, because neither can be reproduced today:
>
> - **§3–§5**, the Oxc comparison — it needs oxlint and oxfmt installed, and
>   they were removed with the decision.
> - **The version table in §7**, which compares 2.5.4 against 2.5.5 — the repo
>   has moved to 2.5.5, so the 2.5.4 column can no longer be re-taken.
>
> So the same command shows different absolute medians in different places
> (`biome check --write` on one file: 458.5 ms in §1, 355.5 ms in §3.1, 354.6 ms
> in §7's version table). None is wrong — **only ratios *within* a single table
> are comparable.** Absolute times on this shared x86-64 container move by 2–3×
> between an idle and a busy run; the `--skip=types` path is the stable one,
> because it is short.
>
> The conclusion does not depend on any of it: `--skip=types` removes the
> type-inference pass entirely, so it wins by a wide margin on every version and
> load level measured.

---

## 1. TL;DR

**No new tool is needed.** The `PostToolUse` hook is slow for a reason that has
nothing to do with Biome vs Oxc: two `types`-domain rules in `biome.json`
(`useArrayFind`, `useArraySortCompare`) force a project-wide type-inference pass
on **every** invocation, single file included. Skipping that domain in the hook
brings Biome to oxlint's speed:

| Hook command | Median (1 file) | vs today |
| --- | ---: | ---: |
| `biome check --write` *(the old hook)* | 458.5 ms | 1× |
| `biome lint` *(lint-only, no other change)* | 433.9 ms | 1.1× |
| **`biome lint --write --skip=types`** | **137.0 ms** | **3.3×** |
| `biome lint --skip=types` *(no write)* | 116.9 ms | 3.9× |

`biome lint --skip=types` lands at 116.9 ms against the ~100 ms oxlint managed
on the same machine — the same order, with one flag, no second toolchain, and no
rule lost (the two type-aware rules still run at pre-commit and in CI).

**Two corrections this measurement forces**, both worth reading before acting:

- **Lint-only is not the win.** Dropping the formatter from the hook buys ~15 %
  (413 → 354 ms), not the speedup. Biome's cost is the type-inference pass, not
  the formatter — `biome format` alone is 144 ms project-wide.
- **`biome check`'s "fixed pipeline cost" was misattributed.** An earlier
  reading of §3.1 blamed a generic `check` overhead; it is specifically the
  `types` domain. `--skip=types` removes it from `lint` *and* `check`
  (697 → 376 ms project-wide).

### The architecture that was applied — Biome only

| Stage | Command | Wired in | Cost |
| --- | --- | --- | ---: |
| `PostToolUse` (per edit) | `biome lint --write --skip=types <file>` | `.claude/settings.json` | **137.0 ms** |
| pre-commit (staged) | `biome check --write --error-on-warnings <files>` | lefthook (`lefthook.yml`) | 503.5 ms |
| pre-push | *nothing* | — | — |
| CI | `pnpm check` — the same command, repository scope | `.github/workflows/ci.yml` | 807.2 ms |
| CI | `biome migrate --write` + `git diff --exit-code biome.json` | `.github/workflows/ci.yml` | ~50 ms |

**Why CI carries a second Biome step.** `pnpm check` runs Biome in check mode, so
an upgrade that changes formatter or lint output fails on the bump PR itself
rather than surfacing later in an unrelated contributor's diff. Deprecated
*configuration* had no equivalent: Biome reports it as an `info` diagnostic,
which `--error-on-warnings` does not fail on, so it slides through until the next
major turns it into a hard error. `biome migrate` has no check mode — it exits 0
whether or not a migration is pending — hence write-then-diff. Nothing is written
on the passing path.

The pre-commit stage runs through **lefthook** rather than a hand-written hook.
Its glob spans the whole repository, like `pnpm check`, so pre-commit and CI
cannot disagree — both defer the perimeter to `biome.json` `files.includes`
rather than repeating a path list — and `stage_fixed: true` re-stages whatever
`--write` repaired.

**Why lefthook and not husky + lint-staged.** That was the first implementation
and it worked, but husky's last release is 2025-01-11 — 18 months stale — and
lefthook (monthly releases, latest 2026-07-08) covers both jobs in one
dependency instead of two. `lefthook-linux-arm64` exists, so Termux/PRoot is
covered. Its `postinstall` stays **blocked** in `allowBuilds` — see the traps
below.

**Partial staging is handled, contrary to what the docs suggest.** lefthook's
`stage_fixed` is documented as nothing more than "lefthook will automatically
call `git add` on files after running the command", and its configuration
reference lists no stash or hide option — which reads like the unstaged hunks of
a partially staged file would be swept into the commit. Measured instead of
assumed, and the behaviour is the opposite:

| | content |
| --- | --- |
| index before | `one   =11` / `two = 2` / `three = 3` |
| worktree before | `one   =11` / `two = 2` / `three   =33` |
| **committed** | `one = 11` / `two = 2` / **`three = 3`** — the staged version, formatted |
| worktree after | `one = 11` / `two = 2` / **`three   =33`** — unstaged edit intact |

So lefthook hides unstaged changes for `pre-commit` the way lint-staged does.
Parity on the one property that justified lint-staged in the first place.

**Two traps found while wiring it up**, both worth keeping in mind:

- **lefthook's `glob` was eventually removed rather than widened**, and its
  matcher is why. `**/*.{ts,…}` alone **silently skips top-level files** — the
  matcher requires at least one directory level for `**/` — whereas `*.{ts,…}`
  alone matches at *every* depth, because lefthook's `*` crosses `/`. So the
  two-pattern config that fixed the first problem handed Biome every nested file
  **twice**, and its extension list was a second perimeter that had already
  drifted from `biome.json`: it omitted `.mts` — which `biome.json` carries an
  override for — plus `.tsx`, `.cts`, `.jsx` and `.css`, all of which Biome 2.5.6
  parses, so staging one of those skipped pre-commit and failed in CI instead.
  Widening the list would only have moved the drift. Passing `{staged_files}`
  unfiltered and letting Biome skip what it cannot parse removes all three
  problems at once, and costs nothing when nothing matches: Biome skips
  unparseable files with a verbose-only `files/missingHandler`, so a docs-only
  commit reports `Checked 0 files` and exits 0 in 0.07 s
  (`--no-errors-on-unmatched` covers the empty set). Measured, not assumed — with
  both patterns lefthook emitted `root.json src/deep/nested.ts src/top.ts top.ts
  src/deep/nested.ts src/top.ts`.
- `pnpm add -D lefthook` writes a `lefthook: set this to true or false`
  placeholder into `allowBuilds`, which makes every later `pnpm` command fail
  until it is resolved. Set to `false`: the postinstall only downloads the Go
  binary as a fallback, and the platform optional dependency already provides
  it (verified — `lefthook version` works with `ERR_PNPM_IGNORED_BUILDS`).

Nothing is lost: the two type-aware rules simply move off the per-edit path to
pre-commit, which runs the identical command as CI. They are `useArrayFind` (a
style suggestion) and `useArraySortCompare` (a real bug class) — and both
currently report **zero findings**, including at the repo's two `.sort()` sites
where Biome's inference cannot resolve the receiver type. See
[§3.4](#what-skipping-them-actually-costs) for what that means, why the daemon
is not a way around it, and a zero-cost `grep` fallback if the `.sort()` risk
matters.

### Why Oxc is not adopted

| Question | Answer |
| --- | --- |
| Is oxlint faster than Biome? | Only against Biome's *unskipped* config. Against `biome lint --skip=types` it is **100.2 vs 103.5 ms** — a tie. |
| Does oxlint cover our rules? | **88.6 %** exact equivalents (124/140), 5 partial, 11 missing — of which 3 are covered by `tsc` or oxlint's own parser, leaving **8 real gaps**. Adopting it means losing coverage for no speed gain. |
| Does oxfmt match Biome's formatting? | Yes — **byte-identical on 68 of 70 TypeScript files** after `oxfmt --migrate=biome`. But it is slower (254.9 vs 144.6 ms project-wide) and cannot sort imports. |
| Would two linters be safe to run side by side? | No. A parity oxlint config produced **83 diagnostics on a tree Biome calls clean**, 8 of them surviving full tuning. Two rule sets over the same files drift; one rule set cannot. |

The Oxc evaluation is kept in full below — it is what produced the measurement
that made the Biome-only fix visible, and it is the record to revisit if oxfmt
reaches 1.0 or Biome's type-inference cost changes.

---

## 2. What is actually being compared

| | Version | Role today |
| --- | --- | --- |
| Biome | 2.5.5 | lint + format + import sorting (`pnpm check`, `PostToolUse` hook) |
| oxlint | 1.75.0 | lint only |
| oxfmt | 0.60.0 | format only (pre-1.0) |
| oxlint-tsgolint | 7.0.2001 | optional, enables oxlint's type-aware rules |

During the evaluation the repo was pinned to Biome 2.5.4 and 2.5.5 was still
inside the release cooldown, so the comparison ran on 2.5.5 via
`--config.minimumReleaseAge=0`. Renovate has since shipped 2.5.5 (#190), and
§1/§6/§7 were re-measured on it — the version gap mattered a great deal on the
type-inference path; see [§7](#the-biome-version-mattered-more-than-expected).

**Measurement platform caveat.** All timings are from the Linux x86-64 CI
container (4 vCPU Xeon @ 2.10 GHz), **not** from Android/Termux/PRoot. Absolute
numbers do not transfer; the ratios are indicative.

One structural factor would have favoured Oxc on the device — PRoot taxes
syscalls and page mapping, and the Biome binary is **63 MB** against 16 MB for
oxlint — but it no longer decides anything: §3.4 removes the gap on the same
binary, so the recommendation does not depend on re-measuring there. Re-running
`scripts/bench-lint-tooling.mjs` on the device is still worth doing to confirm
`--skip=types` delivers a comparable ratio under PRoot.

---

## 3. Performance

Median of 9 runs, 2 warm-up runs discarded.

### 3.1 The hook path (one file — what `PostToolUse` actually runs)

| Command | Median | vs today |
| --- | --- | --- |
| `biome check --write` (today's hook) | **355.5 ms** | — |
| `biome lint` | 348.1 ms | |
| `biome check --write --linter-enabled=false` (format + assists) | 225.6 ms | |
| `biome format --write` (format only, **no import sorting**) | 79.0 ms | |
| `biome check --write --use-server` (daemon) | 292.6 ms | 1.2× |
| `oxlint` | **95.4 ms** | |
| `oxfmt --check` | 181.4 ms | |
| `oxlint` + `oxfmt` | **261.2 ms** | 1.4× |
| `oxlint` + `biome format --write` (no import sorting) | **166.6 ms** | **2.2×** |
| `oxlint` + `biome check --linter-enabled=false` (import sorting kept) | 315.0 ms | 1.13× |
| `oxlint --type-aware` | 347.5 ms | |

Three things stand out.

**Biome's cost is in the linter, not the formatter.** `biome format` on one file
is 79 ms — already cheap. The 355 ms comes almost entirely from `biome lint`.

**`biome check` has a large fixed cost that is not the assist.** Isolating each
stage on a single file:

| Command | Median | Delta |
| --- | ---: | --- |
| `biome format` | 85.0 ms | formatter-only path |
| `biome check --linter-enabled=false --assist-enabled=false` | 267.2 ms | **+182 ms just to enter `check`** |
| `biome check --linter-enabled=false` (assists **on**) | 251.0 ms | assists ≈ free |
| `biome check --assist-enabled=false` (lint + format) | 375.7 ms | linter ≈ +110 ms |
| `biome check` (everything) | 362.6 ms | — |

Turning assists off changes nothing measurable (375.7 vs 362.6 ms is inside
run-to-run variance), so `organizeImports` is not what costs.

**What that ~180 ms actually is — see [§3.4](#34-the-real-cause-two-type-aware-rules).**
It is not a generic `check` overhead, as this table first suggested. It is the
type-inference pass demanded by two `types`-domain rules, and it is removable
with a flag. The rest of §3 was measured *before* that cause was isolated, so
every Biome figure in §3.1–§3.3 carries it.

**oxfmt is the slow half of the Oxc pair.** Its own reported work on a single
file is 32 ms, but wall-clock is 181 ms. Measured startup cost:

| Binary | `--version` wall time |
| --- | --- |
| `biome` | 54.3 ms |
| `oxlint` | 54.2 ms |
| `oxfmt` | **124.4 ms** |

That ~70 ms fixed penalty is pure overhead on every hook invocation, and it is
the single reason the Oxc pair only reaches 1.4× instead of the linter's 4–6×.

### 3.2 Separated roles: lint on edit, format before sharing

Formatting on every keystroke buys nothing — it matters when code is shared, so
once per commit is enough. Linting is the opposite: the earlier a mistake is
caught, the cheaper it is. Splitting the two roles by *stage* rather than
running both everywhere is the architecture this section measures.

**Lint only — the `PostToolUse` stage (one file)**

| Command | Median | vs `biome lint` |
| --- | ---: | ---: |
| `biome lint` | 368.2 ms | 1× |
| **`oxlint`** | **87.5 ms** | **4.2×** |
| `oxlint --type-aware` | 329.0 ms | 1.1× |
| `oxlint` + `biome lint` (both) | 440.7 ms | 0.8× |

Whole project: `biome lint` 610.5 ms vs `oxlint` 105.6 ms — **5.8×**.

**Format only — the pre-commit stage**

| Command | 5 staged files | whole project | Sorts imports |
| --- | ---: | ---: | --- |
| **`biome format --write`** | **84.4 ms** | **130.2 ms** | ❌ |
| `biome check --write --linter-enabled=false` | 241.1 ms | 333.7 ms | ✅ |
| `oxfmt --write` | 171.9 ms | 205.4 ms | ❌ |
| `oxfmt` + Biome assists | 413.5 ms | — | ✅ |

**oxfmt has no role in this architecture.** Biome's formatter is twice as fast
on the staged set (84 vs 172 ms), 1.6× on the project, *and* it is the only tool
that can sort imports. There is no configuration in which reaching for oxfmt
wins — its 124 ms startup (§3.1) is simply larger than the whole job.

> **Pre-commit, not pre-push, if the formatter writes.** A pre-push hook runs
> after the commits exist, so a formatter that rewrites files there produces a
> dirty tree whose contents are *not* in what gets pushed — you would have to
> amend or add a commit. At pre-push a formatter can only **verify**
> (`--check`, fail on drift). So: write at pre-commit, verify at pre-push or in
> CI. The two stages are not interchangeable for a writing formatter.

### 3.3 Whole project (`src/ tests/ scripts/`, 79 files)

| Command | Median |
| --- | --- |
| `biome check --error-on-warnings` (`pnpm check`) | **600.1 ms** |
| `biome lint` | 563.7 ms |
| `biome format` | 122.0 ms |
| `biome check --use-server` (daemon) | 656.1 ms |
| `oxlint` | **88.2 ms** |
| `oxfmt --check` (Markdown excluded) | 201.0 ms |
| `oxlint` + `oxfmt --check` | **287.0 ms** |
| `oxlint` + `biome format` (no import sorting) | 213.8 ms |
| `oxlint` + `biome check --linter-enabled=false` (import sorting kept) | 346.0 ms |
| `oxlint --type-aware` | 800.4 ms |

`oxlint` costs the same on 79 files as on 1 (88 vs 95 ms) — it is entirely
startup-bound at this repo size. Against `biome lint` that is **6.4× on the
project** and 3.6× on a single file.

> **Markdown trap.** By default oxfmt also formats `.md`, which Biome does not.
> On this repo that means 101 files instead of 72 and pushes `oxfmt --check`
> from 201 ms to 580 ms — Markdown table re-alignment is ~40–70 ms *per file*.
> It also silently reformats 22 committed Markdown files. `ignorePatterns:
> ["**/*.md"]` is mandatory, not optional.
>
> **`--write` is oxfmt's default.** Unlike Prettier and Biome, running `oxfmt
> <path>` with no flag rewrites files in place. Any CI check must pass
> `--check`.

---

### 3.4 The real cause: two type-aware rules

Biome 2 marks some rules with a **domain**. Rules in the `types` domain need
type information, which makes Biome run a project-wide inference pass — on every
invocation, even for a single file. This repo enables exactly two of them, both
added by hand to `biome.json`:

```json
"complexity": { "useArrayFind": "error" },
"suspicious": { "useArraySortCompare": "error" }
```

They are 2 rules out of 221 active, and they cost more than the other 219
combined:

| Command | with `types` | `--skip=types` | Saved |
| --- | ---: | ---: | ---: |
| `biome lint`, 1 file | 353.5 ms | **103.5 ms** | 71 % |
| `biome lint --write`, 1 file | — | **116.9 ms** | — |
| `biome check --error-on-warnings`, project | 697.2 ms | **375.8 ms** | 46 % |

Verified two ways: removing the rules from `biome.json` in place (80 files still
checked, `biome lint` drops to 106 ms), and `--skip=types` on the command line
(80 files still checked, same result). `types` is the only costly domain in play
— `project`, `test`, `react` and `next` have **no active rule** in this config.

> **A `--config-path` pointing outside the repo silently checks nothing.** The
> first attempt at this measurement used a variant `biome.json` in `/tmp`; it
> reported plausible timings for *zero files*, because `files.includes: ["**"]`
> and `vcs.useIgnoreFile` resolve against the config's directory. Always confirm
> the "Checked N files" line before trusting a Biome benchmark.

**Consequence.** `biome lint --skip=types` is 103.5 ms against oxlint's
100.2 ms. The performance argument for migrating disappears — it was never a
Biome-vs-Oxc gap, it was two rules doing type inference on the hot path.

#### What skipping them actually costs

| Rule | Catches | Exposure in this repo |
| --- | --- | --- |
| `complexity/useArrayFind` | `arr.filter(p)[0]` → `arr.find(p)` | style / micro-perf, no correctness risk. **0 occurrences** of the pattern. |
| `suspicious/useArraySortCompare` | `.sort()` with no comparator — numbers sort lexicographically (`[1, 10, 2, 20, 3]`) | a real bug class, but **2 bare `.sort()` sites**, both sorting strings (the correct default use). |

And neither rule fires on those two sites **even with types enabled**:

```text
biome lint --only=suspicious/useArraySortCompare src/ tests/ scripts/
→ Checked 80 files in 412ms. No fixes applied.
```

The same rule *does* flag `strs.sort()` in a synthetic file where the type is
declared locally, so this is not the code being clean — Biome's inference cannot
resolve `Object.keys(schema.shape).sort()` (Zod-typed) or
`(await client.listTools()).tools.map((t) => t.name).sort()` (cross-module async
chain), which are the repo's only two candidates.

So today these two rules cost **71 % of every hook invocation and 46 % of
`pnpm check`** while reporting nothing, including at the two places where they
structurally should. Moving them to pre-commit loses nothing measurable; whether
they earn their keep at all is a separate question worth asking.

**The daemon is not an alternative.** Biome's `--use-server` removes process
startup but re-runs the inference pass every time:

| | median (1 file) |
| --- | ---: |
| `lint`, types on, no daemon | 383.5 ms |
| `lint`, types on, `--use-server` | 295.2 ms |
| `lint --skip=types`, no daemon | **105.9 ms** |
| `lint --skip=types`, `--use-server` | 123.8 ms |

295 ms is still 2.5× the target, and with `--skip=types` the daemon is *slower*
than the plain CLI — its IPC overhead exceeds the startup it saves. Keeping
type-aware rules on the per-edit path is not affordable by any route measured.

**If the `.sort()` risk still matters**, it is a purely syntactic pattern: a
`grep -n '\.sort()\|\.toSorted()'` in the hook costs ~0 ms and needs no type
information. It over-reports (it cannot tell a string sort from a numeric one)
but it closes the only real correctness gap at zero latency.

## 4. Lint rule coverage

### 4.1 Method

No hand-waving and no reading of marketing tables. The mapping was derived
mechanically:

1. Enumerated the 509 Biome rules from `configuration_schema.json`, then ran
   `biome explain <rule>` on each to get its `recommended` flag, severity,
   fixability and target language.
2. Applied this repo's `biome.json` (recommended + 8 explicit overrides,
   minus `useLiteralKeys`) → **221 active rules**.
3. Dropped rules that cannot fire here (JSX, CSS, GraphQL, Vue, and Biome's own
   meta-rules about `biome-ignore` comments — the repo is `.ts`/`.mjs`/`.md`/
   `.json` only) → **157 relevant rules**, of which 17 turned out inert on
   closer inspection → **140 applicable**.
4. Built an exact Biome ↔ ESLint mapping by running `biome migrate eslint`
   **709 times in isolation**, one rule per run, and diffing the emitted
   `biome.json`. That yields authoritative pairs rather than guesses.
5. Cross-checked each pair against oxlint's full 738-rule inventory
   (`oxlint --print-config` with every plugin and category enabled).
6. **Verified empirically:** extracted the `expect_diagnostic` "invalid" example
   from every Biome rule's own documentation (148 probe files, 147 confirmed to
   trigger Biome) and ran oxlint over them, recording which rule fired.

### 4.2 Result

| Verdict | Count | Share of applicable |
| --- | ---: | ---: |
| Full equivalent in oxlint | **124** | **88.6 %** |
| Partial equivalent | 5 | 3.6 % |
| No equivalent | 11 | 7.9 % |
| *(inert here — JSX/CSS/GraphQL/meta)* | *17* | *n/a* |

**No equivalent (11) — but 3 are covered elsewhere in the toolchain.**

| Biome rule | Covered by | Note |
| --- | --- | --- |
| `complexity/noEmptyTypeParameters` | **oxlint's parser** | verified: reports `TS(1098) Type parameter list cannot be empty` — a parse error, stricter than a lint rule |
| `suspicious/noDuplicateParameters` | **`tsc`** | verified: `TS2300 Duplicate identifier` under `--strict`; `pnpm typecheck` catches it |
| `suspicious/noRedundantUseStrict` | **the module system** | moot — the package is `"type": "module"`, strict mode is implicit |
| `complexity/noThisInStatic` | — | |
| `complexity/noUselessStringRaw` | — | |
| `complexity/useSimpleNumberKeys` | — | |
| `correctness/noStringCaseMismatch` | — | |
| `performance/noDynamicNamespaceImportAccess` | — | |
| `suspicious/noAssignInExpressions` | *partly* | shadowed by `no-cond-assign` / `no-return-assign` |
| `suspicious/noImplicitAnyLet` | — | |
| `suspicious/noOctalEscape` | — | `no-octal-escape` absent from oxlint |

So the genuine, unmitigated loss is **8 rules**, not 11.

**None of the 16 lost-or-weakened rules fires on this codebase.** Verified
directly: `biome lint` restricted to exactly those 16 rules over
`src/ tests/ scripts/` reports zero findings in 79 ms.

**Partial (5).** The oxlint counterpart exists but is broader or narrower:

| Biome rule | oxlint counterpart | Divergence |
| --- | --- | --- |
| `complexity/noUselessContinue` | `no-continue` | bans *all* `continue` — **12 false positives here** |
| `suspicious/noConfusingLabels` | `no-labels` | bans *all* labels |
| `complexity/useArrowFunction` | `prefer-arrow-callback` | callbacks only, not every function expression |
| `complexity/noFlatMapIdentity` | `unicorn/prefer-array-flat` | different trigger |
| `correctness/noVoidTypeReturn` | `typescript/no-confusing-void-expression` | needs `--type-aware` |

**Type-aware rules.** Biome 2 ships rules in the `types` domain — this repo
enables two of them explicitly (`useArrayFind`, `useArraySortCompare`). oxlint
covers both, but `typescript/require-array-sort-compare` requires
`--type-aware`, which needs the extra `oxlint-tsgolint` package and takes the
project run from 88 ms to **800 ms** (9×). Verified working; the linter finds 8
additional type-aware issues in `scripts/` and `tests/` that Biome does not
report.

### 4.3 Same rule name ≠ same defaults

This is where the real migration work sits. A naive parity config (129 rules
derived from the mapping) produced **83 diagnostics on a tree Biome reports as
clean**. Tuning brought it down to **8**:

| Cause | Count | Fix |
| --- | ---: | --- |
| `vitest` plugin auto-enables its own rules | 45 | don't enable the plugin (or opt in deliberately — see §5) |
| `no-continue` over-broad | 12 | drop the rule |
| `eqeqeq` defaults to `always`; Biome's `noDoubleEquals` defaults to `ignoreNull: true` | 9 | `["error", "smart"]` |
| `unicorn/no-useless-undefined` also checks call arguments | 8 | `{ "checkArguments": false }` |
| `no-use-before-define` flags hoisted functions | 1 | `{ "functions": false }` |

Residual 8 diagnostics after tuning — genuine behavioural differences requiring
code changes or suppressions:

- `prefer-template` ×2 — oxlint flags multi-line string concatenation that Biome
  accepts (readable multi-line error messages in `token-store.ts`,
  `help-center.ts`)
- `prefer-const` ×2 — `let x: T;` assigned later in a nested scope; Biome is
  more conservative
- `no-use-before-define` ×1, `unicorn/no-useless-undefined` ×1
- `typescript/no-explicit-any` ×1 and `no-template-curly-in-string` ×1 — both
  already carry a `biome-ignore` comment that **oxlint does not understand**

On suppressions: the repo has only **2 `biome-ignore` comments**, so rewriting
them as `oxlint-disable-next-line` is trivial. This would be a serious cost in a
larger codebase.

### 4.4 What oxlint adds

Not in Biome, available behind plugins: `import` (33 rules), `promise` (16),
`node` (10), `vitest` (73 — including `require-to-throw-message`,
`no-conditional-expect`, `expect-expect`, which flagged 45 real spots in our test
suite), `jsdoc` (22). Plus 26 Oxc-native rules with no ESLint ancestor
(`oxc/const-comparisons`, `oxc/only-used-in-recursion`, `oxc/missing-throw`…).

Worth noting for a project whose test suite is a first-class asset: the `vitest`
plugin's findings looked legitimate on inspection.

---

## 5. Formatting: oxfmt vs Biome

### 5.1 Fidelity — the good surprise

`oxfmt --migrate=biome` reads `biome.json` and emits a complete `.oxfmtrc.json`
(quote style, semicolons, print width, indent, trailing commas) with no manual
work.

Formatting the whole tree with that config and diffing against the current
Biome-formatted source:

| Directory | Files | Differences |
| --- | ---: | ---: |
| `src/` | 40 | **0** |
| `scripts/` | 5 | **0** |
| `tests/` (`.ts`) | 25 | **2** |

Both differences are line-breaking choices on long assignments, where oxfmt
follows Prettier:

```ts
// Biome
const { authenticateViaBrowser, refreshAccessToken, startBrowserAuth } = await import(
  '../../../src/auth/browser-oauth'
);

// oxfmt
const { authenticateViaBrowser, refreshAccessToken, startBrowserAuth } =
  await import('../../../src/auth/browser-oauth');
```

No divergence on quotes, semicolons, width or indentation. A migration would be
a **2-hunk diff**, not a repo-wide reformat.

### 5.2 The blocking gap: import sorting

`biome.json` enables `assist.actions.source.organizeImports`, and the hook
applies it on every edit. **Neither oxfmt nor oxlint provides this.** oxfmt does
not touch import order (verified). oxlint has `sort-imports`, but that is an
ESLint *reporting* rule with different grouping semantics — it is not Biome's
organize-imports assist, and it does not auto-fix on save the same way.

Dropping Oxc in as a straight replacement therefore **loses automatic import
sorting**, with no workaround inside the Oxc toolchain.

This is decisive only for a full swap. In the split architecture (§6) Biome
stays the formatter, so `organizeImports` is kept as-is — it just moves from
every edit to once per commit, where its cost is irrelevant.

### 5.3 Other formatting notes

- oxfmt formats Markdown (Biome does not) — new capability, but see the
  Markdown trap in §3.2.
- oxfmt formats JSON; output matched Biome's on a smoke test.
- oxfmt is **0.60.0, pre-1.0**. Weekly releases, no stability guarantee.
  Formatter output changing under us between releases is a real risk for a repo
  that gates CI on `--check`.
- Both tools ship an LSP (`oxlint --lsp`, `oxfmt --lsp`), so editor integration
  is not a blocker.

---

## 6. Options

§3.4 changes the option space entirely. Before it, the choice looked like
"a slow Biome or a fast Oxc". After it, Biome and oxlint are the same speed and
the question becomes what each option *costs*.

### 6.1 The `PostToolUse` stage — lint only

| | 1 file | Rule coverage |
| --- | ---: | --- |
| `biome check --write` *(the old hook)* | 458.5 ms | 100 % |
| `biome lint` *(lint-only, nothing else changed)* | 433.9 ms | 100 % |
| **`biome lint --write --skip=types`** | **137.0 ms** | 219/221 rules; the 2 skipped run at pre-commit |
| `oxlint` *(measured in the §3 session)* | ~100 ms | 88.6 % full, 3.6 % partial, 7.9 % missing |

oxlint is in the same range and 8 rules poorer, in exchange for a second
toolchain, a second rule config to keep tuned, and the drift risk of §6.3. That
is not a trade worth making.

Note that lint-only *by itself* buys ~5 %. The speedup is `--skip=types`; the
lint-only split is what makes skipping it free, since the two type-aware rules
have a natural home one stage later.

### 6.2 The pre-commit stage — the same command as CI

| | staged (5 files) | project |
| --- | ---: | ---: |
| `biome check --write --error-on-warnings` | **503.5 ms** | 807.2 ms |

Deliberately identical to CI, differing only in scope. This is what makes CI a
verification step rather than a discovery step: there is no check in CI that the
developer's pre-commit hook did not already run, including the two type-aware
rules the hook skipped.

**No pre-push stage.** It would duplicate pre-commit for no added guarantee, and
a formatter that writes cannot usefully run there anyway — the commits already
exist, so rewriting files at pre-push produces a dirty tree whose contents are
not in what gets pushed.

### 6.3 Why not run both linters

Two rule sets over the same files is a liability. Measured, not hypothesised: a
parity oxlint config produced **83 diagnostics on a tree Biome reports as
clean**. Tuning five diverging defaults brought that to 8, which remain genuine
disagreements — `prefer-template` on multi-line concatenation, `prefer-const` on
deferred assignment, and so on. Both projects ship weekly; that number grows,
and every increment is noise a developer has to arbitrate.

One linter cannot disagree with itself.

### 6.4 What Oxc would still be good for

Kept for the record, none of it decisive:

- **`oxlint --type-aware`** finds 8 real issues Biome does not report — but it
  costs 953.4 ms project-wide and needs `oxlint-tsgolint`.
- **The `vitest` plugin** (73 rules) flagged 45 spots in the test suite. Biome
  has no equivalent. Worth reviewing on its own merits.
- **oxfmt** matches Biome's output on 68/70 files. Revisit at 1.0, if Biome's
  formatter ever becomes the bottleneck — it is not one today (144.6 ms
  project-wide).

---

## 7. What was applied

**Stayed on Biome. Changed the hook command, not the toolchain.** A 3.3× faster
per-edit hook with **no second linter, no second rule config, no coverage loss
and no drift risk**.

| # | Change | File |
| --- | --- | --- |
| 1 | `PostToolUse` hook: `check --write` → `lint --write --skip=types`. Lints on every edit, no longer formats. | `.claude/settings.json` |
| 2 | pre-commit job: `biome check --write --error-on-warnings` on staged `src`/`tests`/`scripts` files, `stage_fixed: true` | `lefthook.yml` |
| 3 | `lefthook` added; `prepare` extended with `lefthook install` so `pnpm install` wires the hook | `package.json` |
| 4 | Why `--skip=types` exists, so it is not silently reverted | `AGENTS.md` (Code style) |
| 5 | Stage table, `--no-verify` bypass, partial-staging caveat | `CONTRIBUTING.md` (Development setup) |
| 6 | Evaluation artifacts removed: `oxlint`, `oxfmt`, `oxlint-tsgolint`, `.oxlintrc.json`, `.oxfmtrc.json` | — |

`pnpm check`, `biome.json` and CI are **unchanged** — they already ran the target
command. `biome.json` keeps both `types`-domain rules: they are skipped on the
hot path by a flag, not removed, so pre-commit and CI still enforce them.

### The Biome version mattered more than expected

While this change was in review the repo was pinned to Biome **2.5.4**, and the
gap to 2.5.5 on the type-inference path turned out to be large:

| Biome | `check --write`, 1 file | `lint --write --skip=types`, 1 file |
| --- | ---: | ---: |
| 2.5.4 | 1348.6 ms | 112.3 ms |
| 2.5.5 | 354.6 ms | 104.3 ms |

*This table alone is from the pre-merge session — the repo is on 2.5.5 now, so
the 2.5.4 column cannot be re-taken. Its two rows are directly comparable to
each other; they are not comparable to the stage tables above.*

Same machine, same config. The skipped path is flat across versions — only the
type pass moved, by ~3.8×. On 2.5.4 this change made the hook **12×** faster;
on 2.5.5 it is 3.3×, because 2.5.5 had already recovered most of that cost.

Renovate shipped 2.5.5 in #190 and this branch merged it, so the figures in §1,
§6 and §7 are measured on the version the repo actually runs. The lasting point
for future bumps: a Biome release that touches type inference moves `pnpm check`
and the pre-commit hook a great deal, and the per-edit hook not at all —
`--skip=types` already sidesteps that path.

Not done, tracked here rather than lost — both independent of this decision:
`oxlint --type-aware` found 8 issues Biome does not report, and oxlint's
`vitest` plugin flagged 45 spots in the test suite (§6.4).

## Appendix A — how the numbers were produced

### Timings — re-run these on the target device

```sh
node scripts/bench-lint-tooling.mjs        # 9 runs per scenario, 2 warm-ups discarded
RUNS=15 node scripts/bench-lint-tooling.mjs
```

`scripts/bench-lint-tooling.mjs` covers the three stages of §6 plus the Oxc
references, and prints both a table and a JSON line. Scenarios whose binary is
absent skip themselves, so it keeps working after the Oxc devDependencies are
removed.

**The "Checked N files" line is now asserted by the script** — it refuses to
time a Biome scenario that matched nothing, rather than reporting an excellent
number for doing no work. That guard exists because of the `--config-path` trap
in §3.4. The `--write` scenarios do write, so the script snapshots every file
they can touch and restores it afterwards, including on Ctrl-C.

### Rule coverage — one-off analysis

The mapping was derived mechanically rather than read off a comparison table:

```sh
# 1. Both toolchains at their latest release (bypasses the 7-day cooldown)
pnpm add -D --config.minimumReleaseAge=0 \
  @biomejs/biome@latest oxlint@latest oxfmt@latest oxlint-tsgolint@latest

# 2. Biome rule inventory — 509 rules from configuration_schema.json, then
#    `biome explain <rule>` on each for recommended / severity / fix / language

# 3. Exact Biome <-> ESLint pairs — one isolated dir per ESLint rule,
#    `biome migrate eslint --write`, diff the emitted biome.json. 709 runs.

# 4. Empirical check — extract each Biome rule's own `expect_diagnostic` example
#    into a probe file (148 of them, 147 confirmed to trigger Biome), then run
#    oxlint with every plugin and category enabled over the same probes and
#    record which rule fires.

# 5. oxlint inventory for cross-referencing
oxlint -D all -D nursery --import-plugin --promise-plugin --node-plugin \
  --vitest-plugin --jsdoc-plugin --react-plugin --jsx-a11y-plugin \
  --react-perf-plugin --nextjs-plugin --print-config      # 738 rules

# 6. Formatting fidelity
oxfmt --migrate=biome
cp -r src tests scripts /tmp/cmp && (cd /tmp/cmp && oxfmt src tests scripts)
diff -rq src /tmp/cmp/src && diff -rq tests /tmp/cmp/tests && diff -rq scripts /tmp/cmp/scripts
```

### Reproducing the Oxc side

The Oxc packages are **no longer devDependencies** — they were removed with the
decision (§7), along with `.oxlintrc.json` (the tuned 129-rule parity config)
and `.oxfmtrc.json`. `scripts/bench-lint-tooling.mjs` skips its Oxc rows when
the binaries are absent, so it still runs as the Biome benchmark.

To re-run the comparison, reinstall them temporarily and recover the two configs
from this branch's history:

```sh
pnpm add -D --config.minimumReleaseAge=0 oxlint@latest oxfmt@latest oxlint-tsgolint@latest
git show <commit-before-removal>:.oxlintrc.json > .oxlintrc.json
git show <commit-before-removal>:.oxfmtrc.json > .oxfmtrc.json
```

The `--config.minimumReleaseAge=0` bypass is for one-off evaluation only; the
7-day cooldown in `pnpm-workspace.yaml` stays in force for real dependencies.
