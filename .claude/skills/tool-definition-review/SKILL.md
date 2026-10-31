---
name: tool-definition-review
description: Use when a diff touches src/tools/**, whether a tool definition (name, title, description, parameter descriptions, annotations) or the handler behind it, including from /code-review; when asked to review or improve how a tool describes itself to agents; or when a tool scores low on Glama.
---

# Tool definition review

An agent picks and calls a tool from its definition alone: what `tools/list`
returns. This review judges that text the way Glama's score does, on the part
no test can: whether it is *good*. `pnpm test` already enforces the floor
(rules A/B/C in `tests/unit/tools/tool-quality.test.ts`, the `tools/list` gate
in `tests/tool-definitions/`); never report what those already fail on.

The rubric (six tool dimensions with weights, four coherence dimensions) is
described in `docs/mcp-metadata.md`. The per-point anchors are Glama's own,
shipped in `mcp-tdqs`:

```sh
node -e "import('mcp-tdqs').then(m => console.log(JSON.stringify({tool: m.TOOL_DIMENSIONS, server: m.COHERENCE_DIMENSIONS}, null, 1)))"
```

## Steps

1. **Deterministic report.** Run `pnpm -s tool-definitions:report`. Any entry
   under "Problems" is a blocking finding: report it as is. If you cannot run
   commands, skip this step and judge from the diff alone.
2. **Scope.** Review the tools whose definition changed: the entries that
   differ in `git diff <base> -- tests/integration/tools-list/` (those
   snapshots pin every tool's `tools/list` entry), or the tools named in the
   request. Add the tools whose handler changed with an unchanged definition:
   check that what the description promises still holds. A new or renamed tool also opens the coherence dimensions for its
   namespace.
3. **Score each tool in scope** on the six dimensions, 1 to 5, against the
   anchors. Give no credit for text that repeats the name, the schema or the
   annotations. Report each dimension under 4, nothing else.
4. **Siblings.** For a tool in scope that the report lists as naming no other
   tool, ask whether an agent could pick a sibling in its place: a tool on the
   same resource and the same side (two reads, or two writes with the same
   verb), or a generic tool sharing its verb (`search` and `search_users`).
   - If one could, that is a Usage Guidelines finding: the description must say
     when to use this tool rather than that one. Naming the sibling is not
     enough; the arbitration is the point.
   - If none could, there is nothing to report. Never add a sibling mention only
     to leave the list.
   - A shadow candidate from the report is a finding only if both tools could
     answer the same request.
5. **Second opinion.** Glama publishes a per-dimension justification for every
   tool of the released version at
   https://glama.ai/mcp/servers/fruggr/zendesk-mcp-server/score. When a tool in
   scope scores under 4.0 there, read its justification before writing yours.

## Each finding

State the tool, the dimension, the sentence at fault (quoted), why an agent
would misread or misuse it, and a rewrite. A rewrite must:

- drop nothing the old text said, unless it was false (`AGENTS.md`,
  multi-agent rule); saying the same in fewer words is a win;
- keep the first sentence standalone, because proxy modes show only it;
- state only Zendesk behaviour that the code, a test or the Zendesk docs back;
  otherwise ask instead of asserting;
- add no padding: Conciseness & Structure scores it down.

Do not ask for an `outputSchema`: tools return text shaped for the agent, by
decision (`docs/decisions/tool-definition-quality.md`).

When asked to apply the rewrites, run `pnpm test` after: the `tools/list`
snapshots will show the change, and each changed `description` must keep every
fact the old one stated.
