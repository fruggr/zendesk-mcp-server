# Tool definition quality: what is gated, what is judged

> **Build documentation, not user documentation.** This records how the quality
> of tool definitions is checked, for maintainers. User-facing docs live one
> level up in [`docs/`](../).

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-10-30 |
| **Applied in** | [#420](https://github.com/fruggr/zendesk-mcp-server/pull/420) |
| **Question** | Can Glama's open-sourced TDQS tooling ([`mcp-tdqs`](https://www.npmjs.com/package/mcp-tdqs), spec [`glama-ai/tool-definition-quality-score`](https://github.com/glama-ai/tool-definition-quality-score)) enhance or replace our definition-quality checks ([#303](https://github.com/fruggr/zendesk-mcp-server/issues/303))? |
| **Answer** | **Complement, not replace.** Its deterministic lint runs in `pnpm test`; its model-scored rubric is applied by a review skill, not by CI. |

## 1. What runs where

| Layer | Where | Nature |
| --- | --- | --- |
| Rules A/B/C, annotation invariants | `tests/unit/tools/` | Deterministic, white box (reads the Zod definitions) |
| `tools/list` gate | `tests/tool-definitions/` | Deterministic, black box (reads what a client reads), every mode |
| Schema non-regression | `tests/integration/tools-list/` snapshots | Deterministic |
| Rubric judgment | `tool-definition-review` skill, applied by `/code-review` | Model, human in the loop |

The `tools/list` gate runs `mcp-tdqs`'s `lintServer` in-process and adds three
checks it lacks: every property described at any depth, no tool both
`readOnlyHint` and `destructiveHint`, and every tool-shaped name in a
description names a tool that exists. Its core (`checks.ts`) imports nothing of
this repository, so it can be lifted into a package for other MCP servers.

## 2. Why the lint and not the score

`tdqs score` sends each definition to an OpenAI-compatible endpoint. That adds a
key and a paid call to CI, and a score is calibrated to a rubric and model pair,
so it would not match Glama's anyway. The lint is the deterministic part of the
same pipeline (context signals, hard gates, shadow prefilter), and its
`inputHash` matches the one Glama publishes. The judgment stays with the
reviewer, through the skill, which reads Glama's anchors from the package rather
than copying them.

Measured on 3.5.3 (63 tools, every namespace): the lint reports no error. It is
looser than rules A/B/C (any non-empty parameter description passes; only a
description equal to the name is tautological), which is why those rules stay.

## 3. What does not gate

`mcp-tdqs` has no suppression mechanism (no ignore flag, no config file), so
the gate filters by rule, never by tool:

- **`shadow-candidate`** is a prefilter by invocation cost that Glama's own
  coherence evaluation confirms or drops. It flags any tool whose sibling takes
  no required argument (`configure_sla_alerts`, then `get_current_user`), and
  moves whenever the surface does, so a per-pair allowlist would churn. It is
  reported as a lead.
- **`no-output-schema`**: tools return text shaped for the agent. An
  `outputSchema` obliges a conforming `structuredContent` and, for older
  clients, the same JSON again as text: more tokens for no gain to an LLM. The
  rubric does not penalise its absence when the description says what comes
  back, which rule C enforces for writes.

Also non-blocking, by design: the list of tools whose description names no
other tool. Four of Glama's six lowest scores were in it, all for not saying
when to prefer a sibling. But a tool without a confusable sibling needs no such
mention, and deciding which siblings are confusable took a heuristic too
brittle to gate on. The skill judges each one instead.

## 4. Revisit when

- `mcp-tdqs` gains a suppression mechanism, or its lint gains rules we would
  gate on (check its changelog when Renovate bumps it);
- a client starts reading `outputSchema` to the agent's benefit;
- another MCP server wants the gate: extract `tests/tool-definitions/checks.ts`.
