---
name: functional-validation-plan
description: Create a functional validation plan for a feature or bugfix. Use whenever you author an implementation plan, finish a feature/bugfix with runtime-observable behaviour, or prepare a PR that needs independent end-to-end validation — even when validation isn't explicitly asked for.
---

# Functional validation plan — author protocol

A code change is not "done" when the unit tests pass. Someone who did **not**
write the code must be able to exercise the feature end-to-end and confirm it
behaves as claimed. This skill produces the brief that lets them do that.

## When to apply

- Whenever you produce an **implementation plan** that changes MCP-runtime-
  observable behaviour: the plan must include a functional validation plan as a
  first-class section, not an afterthought.
- Whenever you land a feature or bugfix whose behaviour is observable at
  **MCP-server runtime** (auth flows, transports, tool surface, resources,
  prompts, persistence, timing).

Skip for changes with no MCP-runtime-observable behaviour: pure docs, comments,
formatting, **and pure tooling / dev-tooling** (build scripts, the
typecheck/lint/format setup, dev-only scripts, CI, release automation) — those
are covered by the standard gates (`pnpm typecheck` / `pnpm check` / `pnpm test`
+ CI), not a third-party functional pass. Say so explicitly rather than silently
omitting the plan.

## Hard rules

- **Independent validator.** Write the plan FOR someone other than the
  implementer — another agent (e.g. the local executor) or a human. Don't assume
  it shares your conversation context: spell out the state to manipulate and how
  to observe results.
- **Assume a fully ready environment — don't make the validator build it.** The
  validator's session is already **on the PR branch, in a live checkout, with the
  MCP server running and authenticated** and its tools loaded as `mcp__<server>__*`
  (`--mode all`). So the plan must NOT ask the validator to:
  - check out / fetch / clone / pull the branch (it's already on it — at most,
    capture `git rev-parse HEAD` to name the SHA);
  - build, install, or start the server (`pnpm …`, transport choices,
    `pnpm mcp:live`, other `scripts/`);
  - locate or configure credentials, tokens, or the base URL (a valid token is
    already wired into the running server and reused by any sanctioned script).

  The validator drives the feature by calling the real `mcp__<server>__*` tools
  directly — that *is* what exercises the running server. A credential/egress
  error is a `BLOCKED` finding to report, never a setup task to perform.
  - **Exception — ground-truth capture.** When the change depends on the shape
    of an undocumented external response that the *formatted* tool output cannot
    reveal (e.g. a Zendesk sideload whose exact field names we guessed), the
    MCP tools are insufficient on their own: they show rendered text, never the
    raw upstream JSON. In that case a small **read-only capture probe**
    (`scripts/probe-*.ts`) IS warranted. It **reuses the already-present auth**
    (the same `ZENDESK_OAUTH_TOKEN` / cached token file the running server uses) —
    state the exact command to run, not how to obtain a token. Make it the first,
    blocking scenario: the validator runs it and pastes the raw payload into the
    PR so the implementer can align the types, any correlation key, and the test
    mocks to reality before the rest of the plan is trusted.
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
   real creds/egress. If a ground-truth capture probe exists (see the exception
   above), state how to run it and that its raw output must be reported.
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
