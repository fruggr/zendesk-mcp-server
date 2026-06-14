---
name: functional-validation-plan
description: Produce a functional validation plan for a feature/bugfix, to be executed by an INDEPENDENT validator (another agent or a human), not the implementer. Use whenever you write an implementation plan, or land a feature/bugfix that warrants end-to-end validation. The plan lives in the PR description; the validator posts their report as a PR comment.
---

# Functional validation plan — author protocol

A code change is not "done" when the unit tests pass. Someone who did **not**
write the code must be able to exercise the feature end-to-end and confirm it
behaves as claimed. This skill produces the brief that lets them do that.

## When to apply

- Whenever you produce an **implementation plan**: the plan must include a
  functional validation plan as a first-class section, not an afterthought.
- Whenever you land a feature or bugfix whose behaviour is observable at runtime
  (auth flows, transports, tool surface, persistence, timing).

Skip only for changes with no runtime-observable behaviour (pure docs, comments,
formatting) — say so explicitly rather than silently omitting it.

## Hard rules

- **Independent validator.** Write the plan FOR someone other than the
  implementer — another agent (e.g. the local executor) or a human. Don't assume
  it shares your conversation context: spell out the state to manipulate and how
  to observe results.
- **Assume a ready environment.** The validator starts on the branch with the
  code operational and the MCP server preconfigured (`--mode all`) with its
  tools already loaded into its Claude Code context. Do NOT add build/install
  steps, transport choices, or CLI harnesses (`pnpm mcp:live`, `scripts/`): the
  validator drives the feature by calling the real `mcp__<server>__*` tools
  directly in its session, which is what exercises the running server.
- **Lives in the PR description.** Put the plan in the PR body under a
  `## Functional validation plan` heading so it travels with the PR. Keep it in
  sync if the change evolves.
- **Report goes to a PR comment.** The validator posts their findings as a PR
  comment (English — `AGENTS.md` rule), referencing each scenario id with an
  OK/FAIL verdict and the observed evidence (logs, file state, tool output).
- **No waiting on real time.** Prefer levers that simulate state (edit a
  persisted timestamp, lower an interval constant, point at an unroutable host)
  over waiting out a real timeout. Call out which behaviours are already covered
  by fake-timer unit tests so the validator doesn't re-prove them needlessly.
- **Distinct from `/functional-testing`.** That harness drives the committed
  inter-LLM scenarios in `tests/functional/`. This skill is the lighter, per-PR
  brief embedded in the PR description. Reference the harness when the change
  belongs there; don't duplicate it.

## Plan structure

Write the plan as a self-contained, copy-pasteable brief:

1. **Context** — the feature and which `mcp__<server>__*` tool call(s) exercise
   it. Note any path that does NOT exercise the code (e.g. a transport the
   feature doesn't touch), so the validator doesn't test the wrong surface.
2. **Setup & prerequisites** — only what's NOT already provided by the ready
   environment: the mutable state to seed/manipulate (on a throwaway copy),
   credentials/egress needed for a real round-trip, and how to observe (log
   level, files, artifacts). Flag what can only be checked partially without
   real creds/egress.
3. **Scenarios** — a table or list, each row: id, what it validates, the exact
   manipulation, the tool call to make, the expected observable. Make "expected"
   concrete (which log event, which file change, which error/URL).
4. **Long-running behaviours** — for anything time-based, give the no-wait lever
   AND note the unit test that already covers it.
5. **Priorities** — which scenarios are the real user-facing paths (do first).
6. **Reporting instructions** — the validator posts a PR comment: per-id verdict
   + evidence; overall green/failing summary.

## Loop

1. Draft the plan from the structure above, tailored to the change.
2. Put it in the PR description under `## Functional validation plan`
   (`mcp__github__update_pull_request`), or include it inline if you're still in
   plan mode and no PR exists yet.
3. Hand it to the independent validator: another agent runs the executor side
   (the `run-validation-plan` skill), or a human picks it up.

## Closing the loop (verifying the report)

The feature is not validated until every scenario is `OK` against the **latest
pushed commit**. When the validator's report lands as a PR comment (you'll get
it as a PR-activity event if subscribed):

1. **Read the report** (`mcp__github__pull_request_read` / the comment body) and
   confirm it tested the right commit SHA. If it's stale (predates your last
   push), ask for a re-run.
2. **Re-verify each scenario — don't trust the verdict blindly.** Check the
   reported evidence against the plan's expected observable yourself: a validator
   can misread a log line or mislabel a pass. Where the evidence is too thin to
   confirm, ask them to re-capture that scenario.
3. **On all OK:** the loop is closed. Note the outcome (a short confirming PR
   comment, or tell the user) — that green report is the deliverable, not a no-op.
4. **On any FAIL/BLOCKED:** diagnose the root cause. If it's a real bug, fix it on
   the branch in a separate commit, push, and ask the validator to re-run the
   affected ids against the new SHA. If it's a `BLOCKED` (missing creds/egress),
   say so and decide with the user whether that scenario can be validated here.
