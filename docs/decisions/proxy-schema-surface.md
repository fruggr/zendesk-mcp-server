# Proxy schema surface: parameter names in the schema, description under the cap

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-10-03 |
| **Applied in** | [#329](https://github.com/fruggr/zendesk-mcp-server/issues/329) |
| **Question** | How does a `namespace` / `single` proxy tell the model each operation's parameter names, without losing operations to client truncation? |
| **Answer** | The tool description stays under 2048 chars and only names the operations. The per-operation detail, `name(params): summary (write)`, goes in the `operation` property description, which clients pass whole. |

## The problem

A proxy takes `{ operation, params }` with `params` an open record, so the model only learned parameter names from the strict parser's error after a failed call (`labels` for `label_names`, `index` for `section_index`).

The operation list itself was also being lost. Claude Code cuts every MCP tool description past 2048 chars and appends `… [truncated]` ([anthropics/claude-code#87650](https://github.com/anthropics/claude-code/issues/87650); `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` overrides it from 2.1.280, but the server cannot count on a client setting). The proxy descriptions before the change:

| Proxy | Operations | Description |
| --- | --- | --- |
| `zendesk_tickets` | 19 | 2 954 |
| `zendesk_help_center` | 29 | 3 772 |
| `zendesk` (`single`) | 60 | 7 937 |

## What the client actually passes

Measured with `scripts/probe-mcp-description-cap.mjs` on Claude Code 2.1.287:

- **Tool description**: cut at 2048 chars.
- **Input-schema property description**: passed whole, verified at 15 000 chars, nested properties included.
- **Deferral**: a large schema can make Claude Code defer the tool behind ToolSearch. Once loaded, the schema is still whole.

## The shape

| Where | Carries | Size after (`help_center` / `single`) |
| --- | --- | --- |
| Tool description | `[RO]` marker, usage, `Operations: a, b, …` (names only, for clients that ignore property descriptions) | 882 / 1 407 |
| `operation` property | one line per operation: `- create_article(section_id*, title*, …, label_names): Create a new article in a section. (write)` | 4 884 / 9 828 |
| `params` property | a pointer to those lines | short |

All of it is built at registration from the filtered tools' real schemas (`src/routing/proxy-schema.ts`), so it follows `--read-only`, `--namespace` and `--tool`, and any field a future tool adds. Required means "rejects `undefined`", the rule the strict parser applies. The summaries and `(write)` markers moved from the tool description to the `operation` property, still in the exposed schema; a client that ignores property descriptions sees only the operation names.

## Rejected

- **Parameter names in the tool description**: makes the truncation worse.
- **`params` as a `oneOf` on `operation`**: 23 KB of schema for `help_center` and 52 KB in `single` mode, which undoes the point of the proxy modes. Client support for `oneOf` also varies.
- **A `describe` operation**: costs a round trip and adds a mechanism. Kept as a follow-up if signatures alone prove too thin (types, enums).

## Guards against drift

| Drift | Guard |
| --- | --- |
| Description grows (new operations or namespaces) | The builder drops the name list rather than cross 2048. `tests/unit/routing/proxy-schema.test.ts` asserts every namespace and `single`, full and read-only, stays under the cap **with** the list, so the fallback never kicks in silently. |
| Signature drifts from the schema | Generated, never hand-written. A real-surface test checks each tool's signature against its keys and its JSON Schema `required`. |
| `operation` field outgrows what was verified | `VERIFIED_SCHEMA_DESCRIPTION_LENGTH` (15 000) is asserted by the same test. Raise it only after the probe passes at the new length. |
| A client starts cutting schema descriptions | On demand, since it needs a live model: run `node scripts/probe-mcp-description-cap.mjs --length <n>`, and functional scenario `07-proxy-param-names`. Re-run after a Claude Code upgrade or when the envelope test trips. |
