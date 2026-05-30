---
name: functional-testing
description: Drive the inter-LLM functional test harness for this MCP server. Use when the user invokes /functional-testing — either with a scenario slug (e.g. `01-namespace-readonly`) or `all`. Reads STATE.md, produces a bridge prompt for the local executor, then ingests reports and writes verdicts. Never reads `expected.md` until the executor has already pushed its report.
---

# Functional testing — leading LLM protocol

You are the **leading LLM** in a two-LLM functional test loop. The other LLM
runs locally on the user's machine (Claude Code CLI), executes scenarios
against the real MCP server build, and pushes its artifacts. You drive the
loop without ever running the server yourself.

## Invocation forms

- `/functional-testing <NN-slug>` — drive a single scenario.
- `/functional-testing all` — drive every scenario in `STATE.md` not yet
  `done`, in order.

## Loop per scenario

1. **Read state.** Open `tests/functional/STATE.md`. Confirm the scenario
   exists and its status. If the user passed `all`, pick the first non-`done`
   row.
2. **Refuse if not your turn.** If `holder` in the frontmatter is not
   `leading`, the executor still owes a push. Tell the user, stop.
3. **Read the spec, NOT the expected.** Open
   `tests/functional/scenarios/<slug>/spec.md`. Do **NOT** open
   `expected.md` yet — opening it before the executor reports would let bias
   leak into the bridge prompt.
4. **Produce a bridge prompt** for the user to paste into their local Claude
   Code session. Template:

   ```
   Tu es dans le repo zendesk-mcp-server, branche locale doit être à jour
   avec origin/<branch-from-STATE>.
   Lis tests/functional/scenarios/<slug>/spec.md et applique strictement
   ses instructions.
   Ne lis PAS expected.md — c'est le critère de verdict, le voir biaiserait
   ton rapport.
   Écris reports/<slug>.raw.json + reports/<slug>.report.md.
   Quand fini, mets à jour tests/functional/STATE.md (status=done,
   holder=leading), commit et push.
   Préviens-moi.
   ```

   Adapt the language to the user's (`AGENTS.md` says GitHub = English, chat
   = user's language).
5. **Wait for the user to confirm the push.** No polling. The user signals
   you in chat.
6. **Pull and read.** `git pull origin <branch>`. Open the executor's
   artifacts: `reports/<slug>.raw.json` (canonical, ground truth) and
   `reports/<slug>.report.md` (executor's narrative + assertion fence).
7. **Now read `expected.md`.** Open
   `tests/functional/scenarios/<slug>/expected.md`. Compare each assertion ID
   between the report fence and the expected values. Re-verify each against
   `raw.json` — don't trust the executor's `actual` blindly; they may have
   miscopied.
8. **Write the verdict** at `tests/functional/reports/<slug>.verdict.md`:

   ```markdown
   # Verdict — <slug>

   | ID  | Status | Notes                                                  |
   | --- | ------ | ------------------------------------------------------ |
   | A1  | OK     | -                                                      |
   | A2  | FAIL   | Expected X, raw shows Y. See `raw.json` `.tools[1]`.   |

   ## Summary

   <green / list of failing IDs>

   ## Proposed actions

   - <if any FAIL: pointer to the code fix, file:line>
   ```

9. **Update `STATE.md`.** Set the scenario row to `OK` or `FAIL`. Bump
   `holder` back to `executor` only if you need them to re-run (e.g. report
   was incomplete). Otherwise leave `holder: leading` and consider the
   scenario closed.
10. **Commit and push** the verdict and STATE update.
11. **If FAIL with a clear root cause:** propose the code fix on the branch
    in a **separate commit** (don't conflate harness output with code
    changes). Push, mention to the user.

## When `all`

Loop steps 1-11 for each pending scenario, in order. Stop on the first FAIL
and surface the diagnosis to the user before continuing — the executor may
need to re-run after a code fix.

## Hard rules

- Never read `expected.md` before the executor has pushed their report.
- Never edit `spec.md` or `expected.md` mid-run.
- Never push a code fix and the verdict in the same commit.
- If you can't reach a verdict (raw JSON corrupted, missing artifact), say so
  in `verdict.md` and ask the user — don't fabricate.
