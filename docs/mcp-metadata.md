# MCP tool metadata — Glama criteria & multi-agent safety

This is the deep dive behind the **Multi-agent compatibility** rule in
[`AGENTS.md`](../AGENTS.md). It answers two questions every tool change must
clear:

1. **New tool** — does its definition meet the quality bar the [Glama
   score](https://glama.ai/mcp/servers/fruggr/zendesk-mcp-server) grades us on?
2. **Tool change** — does the JSON Schema we expose to agents stay a superset of
   what it was (no regression)?

The Glama score is the badge at the top of `README.md`; it is a public,
agent-facing signal of how usable our tools are, so we treat its criteria as a
contract, not a vanity metric.

## Glama score, in one screen

The overall score is **Tool Definition Quality (70 %) + Server Coherence (30 %)**.
The weights and dimensions below are from Glama's public methodology
([glama.ai/mcp/methodology](https://glama.ai/mcp/methodology), retrieved
2026-07-01) — re-check it if the score moves, as the rubric may evolve.

### Tool Definition Quality — 70 %

How well *each individual tool* describes itself to an AI agent. Every tool is
scored 1–5 on six dimensions:

| Dimension | Weight | What it asks |
|---|---|---|
| Purpose Clarity | 25 % | Is it obvious what the tool does and when to reach for it? |
| Usage Guidelines | 20 % | Does the description say when to use it (and when not)? |
| Behavioral Transparency | 20 % | Are side effects, mutations and failure modes stated? |
| Parameter Semantics | 15 % | Does every param have a `.describe()` that explains meaning, format and constraints — not just restate the name? |
| Conciseness & Structure | 10 % | Is it complete without padding? |
| Contextual Completeness | 10 % | Enough context to call it correctly without reading the source? |

**Aggregation matters:** the server-level score is **60 % mean + 40 % minimum**
across all tools. One poorly described tool drags the whole server down, so a new
tool is not "good enough because the average is fine" — it must stand on its own.

### Server Coherence — 30 %

How well the tools work together *as a set*. Four dimensions, weighted equally:

- **Disambiguation** — can an agent tell two similar tools apart from their
  descriptions? (e.g. `search` vs `search_tickets` vs `search_articles`.)
- **Naming Consistency** — verbs, casing and namespace prefixes follow the same
  pattern as the existing surface.
- **Tool Count Appropriateness** — no needless proliferation; prefer an optional
  param over a near-duplicate tool (this is why PR #110 added `attachments` to
  the two comment tools instead of a new `upload_file` tool).
- **Completeness** — no obvious gaps a caller would expect to exist.

## Checklist for a new tool

- Description leads with a **standalone first sentence** — proxy modes surface
  only that sentence (see `AGENTS.md` → Documentation maintenance).
- Every parameter has a meaningful `.describe()` (Parameter Semantics).
- Description states side effects / mutations and what the tool returns
  (Behavioral Transparency), and when to use vs. avoid it (Usage Guidelines).
- Name matches the existing verb/prefix convention (Naming Consistency).
- Adding a param to an existing tool beats a near-duplicate tool (Tool Count).
- Sync the `docs/mcp-tools-reference.md` tool tables in the same PR.

## How this is enforced (floor + ceiling)

The rubric is ~60 % mechanically-checkable structure and ~40 % judgment, so we
enforce it in two layers instead of relying on a human catching every thin tool:

- **Deterministic floor — `tests/unit/tools/tool-quality.test.ts`.** A CI test
  (sibling of `annotations.test.ts`) that iterates every tool and fails, with a
  teaching message, when a definition drops below the floor:
  - every parameter has a `.describe()` that adds information beyond the field
    name (not `ticket_id` → "Ticket ID");
  - the tool `description` is more than one sentence;
  - a write tool (`readOnly: false`) states its effect / return value.

  This guards the **`40 % minimum`** term of the server score — no single tool
  can crater the surface. The failure messages state the intent and point at an
  exemplar tool on purpose: fix by genuinely improving the definition, not by
  padding text to clear the check (padding is caught by the ceiling below).
- **Judgment ceiling — CodeRabbit (`.coderabbit.yaml`).** The `src/tools/**`
  review instructions ask CodeRabbit to score each definition against the six
  dimensions and flag what a static check can't: padded-but-empty descriptions,
  implicit side effects, unverified claims about Zendesk behavior, and
  indistinguishable sibling tools. This runs on the PR, off our pipeline.

When you add or change a tool, run `pnpm test` locally; the floor test tells you
exactly which dimension regressed.

## No regression on a tool change

Agents consume our Zod schemas as **JSON Schema draft-07**. We author schemas
with `zod/v4` (see `src/tools/*`); the MCP SDK serializes them to draft-07
internally via zod v4's mini/`toJSONSchema` path — you don't import `v4-mini`
yourself. A change is *multi-agent-safe* only when the exposed schema stays a
**superset** of the previous one:

- **Never remove or shorten** an existing param `description` or the tool
  description — a stricter agent may key off exact text. Enriching is fine.
- **Never drop** a `required` field or loosen a type in a way that changes the
  emitted schema shape.
- **Adding constraints is an enrichment, not a regression** — e.g. tightening
  `z.string().min(1)` to `z.string().min(1).base64()` only *adds* `format` +
  `pattern` to the draft-07 output and leaves the `description` byte-for-byte
  identical (verified on PR #110). That is exactly the kind of change we want.

**How to verify:** dump the tool's JSON Schema before and after the change and
diff it. The diff must be additive only (new keys/constraints), with existing
`description` strings unchanged. If a field disappears or a description string
differs, it is a regression — stop and rethink.
