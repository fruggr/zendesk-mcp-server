---
name: probe-spike
description: Scope a feature with a probe spike before planning it, or run one. Use when a plan would rest on how Zendesk really answers (a sideload honoured or dropped, a field's location or format, an endpoint's permissions) and the formatted MCP tool output cannot show it — and when you are handed a "Spike protocol" in a PR to execute.
---

# Probe spike — scope from ground truth, then plan

Zendesk's docs are thin on response shapes, and the tools return formatted text,
never raw JSON. A plan built on a guessed shape fails late: types, mocks and
tests all encode the guess. So when a plan rests on such a fact, measure it on a
live tenant **before** writing the plan. Order: **spike → report → plan →
owner's go → code.** No feature code before the plan is approved.

Skip the spike when every fact the plan needs is already observable through the
MCP tools, or already pinned by a mock that a live run confirmed.

## Author side

1. **List the questions.** Each one is a fact the plan branches on (Q1, Q2…),
   stated so a yes/no or a shape answers it. Mark which can be answered through
   the existing `mcp__<server>__*` tools and which need raw payloads.
2. **Write the probe** for the raw-payload questions: `scripts/probe-<topic>.ts`,
   following the conventions in `docs/live-testing.md` (Probes). In particular:
   - credentials from `scripts/live-auth.ts`, never from the caller;
   - GETs only, through `zendeskGet`;
   - print keys, ids, stages, timestamps, numbers — never subjects, bodies or
     names;
   - a failing step is a finding: report it and carry on;
   - auto-discover a sample that can actually answer the question (a ticket
     that carries an SLA, a non-empty view) instead of trusting a hard-coded id.
   Gates: `pnpm typecheck`, `pnpm check`. A probe is dev tooling, exempt from a
   functional validation plan.
3. **Open a draft PR** carrying the probe and a `## Spike protocol` section in
   its description, written for an agent that has none of your context:
   - **Hard rules first**: never read, print, export or `curl` with the token
     (the session security classifier blocks it; every step resolves the
     credential itself); read-only in Zendesk; no subjects, bodies or names in
     the report.
   - **Environment**: assume a ready one, as in `functional-validation-plan`
     (on the branch, `zendesk-local` running and signed in). Do not make the
     executor install, build or configure anything.
   - **Steps**: the probe command(s), then the MCP tool calls that give today's
     baseline, then any client facts needed (`claude --version`, OS).
   - **Human hand-offs**: say exactly what to ask the human when the tenant
     lacks the state a question needs (a view column, an SLA policy). The
     executor asks; it never changes the tenant itself.
   - **Report shape**: one section per question, then anomalies, then the raw
     probe output in a collapsed `<details>` block.
4. **Subscribe to the PR** and wait for the report. Do not start coding.

## Executor side

You are handed a PR whose description holds a `## Spike protocol`. Run it
**verbatim** from the PR description, not from a paraphrase.

- Follow the hard rules. When a step fails for lack of credentials or egress,
  report it as `BLOCKED`; do not work around it with a token or a raw HTTP call.
- Run every step even when an earlier one fails: a failure is a finding.
- Report facts, not recommendations: what Zendesk returned, where, in what
  format. The plan is the author's call.
- Post one PR comment in English, shaped as the protocol asks, and state your
  role once in one line ("independent agent, without the implementer's
  conversation"). Name the commit you ran (`git rev-parse HEAD`).

## Closing the loop (author)

1. Check the report against the probe output in its `<details>` block; ask for
   a re-run on a stale commit or thin evidence.
2. Write the implementation plan from the answers, citing each Q it relies on.
   Facts the spike measured become the mocks in `tests/msw-handlers.ts`.
3. Put the plan to the owner. Code starts on their go.
4. Keep the probe while its question can come back (a Zendesk change, a new
   tenant); drop it in its own commit once nothing will ask again.
