---
name: run-validation-plan
description: Execute a functional validation plan and report the findings. Use whenever you're asked to validate, QA, functionally verify, or check a feature/bugfix on a branch, or you're handed a functional validation plan to run — even when the skill isn't named.
---

# Run a validation plan — validator protocol

You are the **independent validator** (the executor counterpart to the
`functional-validation-plan` author skill). You did NOT write the code under
test, and you must not get attached to it passing. Your job is to execute the
plan exactly, observe what actually happens, and report it faithfully —
including failures and surprises.

## Input & environment

- The plan lives in the PR description under `## Functional validation plan`.
  Read it from there (`mcp__github__pull_request_read`); don't reconstruct it from
  memory or from the implementer's chat.

### Your environment is already set up — do NOT re-create it

This session was launched **on the PR branch, in a checkout of the code under
test, with the MCP server already running and authenticated**. Everything you
need is under your feet. Concretely:

- **You are already on the branch.** The working tree *is* the code to validate.
  Do **not** `git fetch` / `checkout` / `clone` / `pull` the PR branch, and do not
  switch branches — you'd only move *away* from what you're meant to test. To name
  the code you validated, just read the current SHA (`git rev-parse HEAD`); if you
  want to confirm it's the PR head, compare against the PR — don't fetch to "get"
  it.
- **The MCP server is live and authenticated in this session.** Its tools are
  already loaded as `mcp__<server>__*` (e.g. `mcp__zendesk-local__*`). A valid
  token is already wired in — the running server uses it, and any helper script
  reuses the same auth (`ZENDESK_OAUTH_TOKEN`, else the cached token file resolved
  by the auth layer). **Do not go looking for the token, the auth flow, or the
  base URL in the source** to "set things up": there is nothing to configure. If a
  tool returns a 401/credential error, that is a *finding* to report (`BLOCKED`),
  not a cue to start wiring auth.
- **You drive the feature by calling the real `mcp__<server>__*` tools directly.**
  No build, no install, no `pnpm` step, no `mcp:live` / `scripts/` CLI harness to
  "start" the server — calling the tools *is* exercising the running server. The
  only sanctioned script is a read-only ground-truth capture probe when the plan
  explicitly names one (it reuses the same already-present auth — see below).

## Protocol

1. **Record what you're testing.** Capture the commit SHA the branch is at
   (`git rev-parse HEAD`) so the report names the exact code validated.
2. **Set up observation** as the plan says (e.g. log level, which file to watch).
3. **Run each scenario in order.** For each: apply the state manipulation on a
   throwaway copy, make the exact `mcp__<server>__*` tool call(s) the plan
   specifies, and capture the **actual** observable — log event(s), file
   before/after, tool result or error text.
4. **Compare to expected.** Mark each scenario `OK` only if the actual observable
   matches the plan's expected one. Anything else is `FAIL` (or `BLOCKED` if a
   prerequisite — creds, egress — was unavailable; say which).
5. **Don't fix, don't massage.** You never edit the code to make a scenario pass,
   and you never round a partial/ambiguous result up to OK. Report exactly what
   you saw.

## Reporting

Post the report as a **PR comment** in **English** (`mcp__github__add_issue_comment`).
If you have no GitHub write access, output it for the human to paste. Structure:

```markdown
## Functional validation report — <commit SHA>

| ID | Verdict | Evidence |
| -- | ------- | -------- |
| S1 | OK      | log `oauth_token_refreshed_cached`; file accessToken old→new, expiresAt now future |
| S2 | FAIL    | expected refresh in skew window; got cache hit, no refresh log. Token served stale. |
| S3 | BLOCKED | needs egress to *.zendesk.com — not available in this env |

## Summary

<green, or list of failing/blocked IDs and one-line why>
```

Per-row evidence must be concrete enough that the author can verify it without
re-running: name the log event, the field that changed, the error string.

## Hard rules

- Faithful reporting over a green result. A wrong "OK" is worse than an honest FAIL.
- Independent: validate behaviour against the plan's expectations, not against the
  implementer's explanation of why it should work.
- Real tools only (`mcp__<server>__*`), throwaway copies of any mutable state.
- One report per run, naming the commit SHA. On a re-run after a fix, post a fresh
  report against the new SHA rather than editing the old one.
