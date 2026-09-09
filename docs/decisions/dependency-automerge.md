# Dependency auto-merge: the criterion is the dependency, not the semver level

> **Build documentation, not user documentation.** This records why Renovate
> auto-merges what it auto-merges here. Nothing in it changes how the MCP server
> behaves for a client. The resulting policy — the table, the batch names, the
> escape hatches — lives one level up in
> [`release-automation.md`](../release-automation.md); this file is the reasoning
> behind it and does not restate it.

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-09-09 |
| **Applied in** | [#276](https://github.com/fruggr/zendesk-mcp-server/pull/276) |
| **Question** | Which dependency updates deserve a human read, and what actually protects the repo from the ones that do not get one? |
| **Answer** | Gate on **what the dependency can reach**, not on its semver level. Two production dependencies define the exposed MCP surface and their minors are read by hand; everything else non-major is batched weekly and auto-merged. |

## 1. What the previous policy really said

`renovate.json` had no `packageRules` entry matching `dependencies`, so every
production update fell through to Renovate's default of no auto-merge. The policy
that was written down as "prod is reviewed, dev is not" was, mechanically, an
empty slot rather than a decision — and it produced two results nobody would
defend on purpose:

- A **security patch on a production dependency was already auto-merged**, and it
  publishes an npm release. An ordinary patch on the same dependency, which
  publishes nothing (`chore(deps)` is a non-triggering type), was blocked. The
  urgent path trusted CI; the harmless one did not.
- A **minor on a devDependency was auto-merged** — `vitest`, `tsdown`, `msw`, all
  of which can break the build or the test signal — while a patch on `open`,
  which this server calls once to open a browser, was not.

The volume made it worse: over the 90 days before this change, **30 of the 50
commits on `main` were `chore(deps)`**. A review that fires on 60 % of commits and
consists of reading a version number is a rubber stamp, and a rubber stamp is
worse than no review, because it is mistaken for a control.

## 2. The criterion: what can this dependency reach?

Semver level is a claim by the publisher about compatibility. It says nothing
about how far a change can travel *in this repository*, which is the thing worth
gating on.

- **`@modelcontextprotocol/sdk` and `zod` define the tool surface itself.** The
  JSON Schema (draft-07) that agents consume is generated from Zod schemas and
  serialised by the SDK. A minor on either can move that schema — exactly what
  the multi-agent compatibility rule in [`AGENTS.md`](../../AGENTS.md) forbids
  degrading, and what [`mcp-metadata.md`](../mcp-metadata.md) exists to diff.
  These two are read by hand.
- **The other thirteen production dependencies are leaves.** `open`, `cheerio`,
  and the `unified` / `remark` / `rehype` chain sit behind our own code. What they
  can change is rendering output, and that is asserted:
  `tests/unit/utils/article-sections.test.ts` pins the HTML ↔ Markdown conversion
  the chain performs, and `tests/unit/utils/formatting.test.ts` holds 63 committed
  `toMatchInlineSnapshot` assertions over the text the tools hand back. A drift
  fails CI; it does not slip through quietly. The mutation gate does not itself run
  on a dependency bump — it only mutates lines the diff changed under `src/` — but
  it is why those assertions are tight enough to catch one.

So the list is two names, not a category, and it is applied to **minors only**.
A patch on `zod` goes through the batch like any other patch, on the bet that a
patch moving the exposed schema is an upstream bug rather than a normal release.
Reviewing `zod` 4.5.4 → 4.5.5 by hand would reintroduce the rubber stamp on the one
dependency where attention is actually worth something.

That bet is not free, and it is worth naming what backs it and what does not. The
suite asserts tool *names* and round-trips every handler through its Zod schema
over a real MCP transport (`tests/integration/core-scenarios.ts`),
`tests/unit/tools/tool-quality.test.ts` walks each tool's Zod shape, and since
[#273](https://github.com/fruggr/zendesk-mcp-server/pull/273)
`tests/unit/tools/schema-compile.test.ts` fails loudly if any tool schema stops
compiling under zod's AOT compiler — a zod-specific tripwire that a patch would
trip. But **nothing asserts the serialised draft-07 JSON Schema itself.** A
snapshot over `tools/list` would close that gap and is the obvious follow-up;
until it exists, a schema regression from a patch reaches CI only if it also
breaks parsing or compilation, and otherwise waits for the inter-LLM functional
tests in `tests/functional/`, which are run on demand.

## 3. What protects the repo, and what does not

**Human review does not detect a compromised package.** Nobody reads
`"open": "11.0.1"` → `"11.0.2"` in a diff and sees a malicious postinstall. What
catches that class of attack is time. This repo has two independent delays, and
they do not cover the same ground:

- `minimumReleaseAge: "5 days"` in `renovate.json`, on every **ordinary** update
  Renovate proposes;
- `minimumReleaseAge: 7200` (minutes) in `pnpm-workspace.yaml`, which pnpm
  enforces natively at resolution time and which therefore also covers the
  transitive tree Renovate does not manage.

Removing the human step does not remove that protection, because the human step
was never the protection.

**The exception is security updates, and it is not ours to choose.** Renovate
documents it plainly: "Security updates bypass any `minimumReleaseAge` checks, and
so will be raised as soon as Renovate detects them"
([key concepts / minimum release age](https://docs.renovatebot.com/key-concepts/minimum-release-age/)).
So on a vulnerability alert the `renovate.json` delay does not apply, and
`internalChecksFilter: "flexible"` in that block has no age check left to keep
visible — it is inert for this purpose and kept only because it still governs any
*other* internal check on those PRs. What remains is the pnpm gate, which bites at
a different moment: Renovate has to run pnpm to update the lockfile, and pnpm
refuses to resolve a version younger than five days. Whether that produces a clean
wait or a failed lockfile step on a security PR has not been observed here yet —
worth watching on the first real alert, because the two are not the same
experience.

The practical consequence, stated so nobody has to rediscover it: a **patch**-level
security fix on a direct dependency can reach `main` quickly, and it publishes a
release when it does. That is the intended trade for a known CVE — the delay exists
against *unknown* compromise, which is a different threat. A minor or major
security update still stops for a human.

This is also where the ecosystem has landed. Renovate's own guidance is to
[automerge](https://docs.renovatebot.com/key-concepts/automerge/) non-major
updates when the test suite is good enough — "it can work for production
`dependencies` too, but your project should have good test coverage" — and the
common Dependabot setup since the 2025–26 supply-chain incidents pairs auto-merged
patch/minor with a cooldown window. Neither treats per-patch human approval as a
security control.

## 4. Batching, and what it costs

Auto-merging without grouping would trade a review queue for a merge-commit
stream: same 30 commits, just faster. Non-major, non-security updates are
therefore grouped into two weekly PRs — production and dev kept separate, so a
broken dev bump does not hold back a production one.

The cost is real and accepted: **one member breaking CI holds its whole batch**,
and a regression found later is attributed to a batch rather than to a bump.
Squash-merge keeps the mitigation cheap — one commit per batch, so `git revert`
takes the whole thing back out. The escape hatch for a stuck batch is in
[`release-automation.md`](../release-automation.md#pause-or-disable).

The Monday window is not cosmetic: `lockFileMaintenance` runs Tuesday and Friday,
both rewrite `pnpm-lock.yaml`, and overlapping windows cost a rebase cascade and
the CI that goes with it.

## 5. The invariant that fails silently

Release levels are decided by the commit title. A batch is titled
`chore(deps): …`, which `.releaserc.json` maps to *no release*; a security update
is titled `fix(security): …`, which maps to a patch release. **If a security
update were ever swept into a batch, it would inherit the batch title and stop
publishing.** Nothing would fail, and nothing would warn.

Renovate keeps packages under a vulnerability alert out of standard grouping by
default, and the `vulnerabilityAlerts` block takes precedence over `packageRules`.
That is two reasons it cannot happen and zero reasons to rely on them: the block
pins `"groupName": null` explicitly. This is the first thing to check the next
time the grouping rules are touched.

## 6. Review condition

Reopen this decision if either of these shows up:

- a batch sits blocked for more than two consecutive weeks — the grouping is then
  costing more than the PR noise it removed;
- a regression reaches `main` through an auto-merged batch that a changelog read
  would plausibly have caught. The answer would be to widen the exception list by
  one name, not to go back to gating on semver.
