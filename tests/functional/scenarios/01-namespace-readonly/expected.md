# ⚠️ LEADING LLM ONLY — DO NOT READ IF YOU ARE THE EXECUTOR

Reading this file biases the report. Stop now and read only `spec.md`.

---

## Expected values (verdict criteria)

- **A1 — count.** `result.tools.length === 3`.
- **A2 — names.** Set equality with `{"zendesk_tickets", "zendesk_help_center", "zendesk_users"}`. Order is irrelevant.
- **A3 — readOnlyHint.** `true` on all 3.
- **A4 — destructiveHint.** `false` on all 3. (Aggregation: `some` of zero destructive ops is `false`. In read-only mode, every sub-tool is read-only by construction.)
- **A5 — idempotentHint.** `true` on all 3. (Every read op is idempotent.)
- **A6 — openWorldHint.** `true` on all 3 (hard-coded in `aggregateAnnotations`).
- **A7 — `[RO] ` prefix.** Every description must literally start with the 5
  characters `[` `R` `O` `]` ` ` (bracket-R-O-bracket-space).

## Failure diagnostics

| If FAIL on | Likely cause                                                                            | Where to look                     |
| ---------- | --------------------------------------------------------------------------------------- | --------------------------------- |
| A1, A2     | Routing filter broken or namespace registration regressed                               | `src/routing/registry.ts`, `src/server.ts` `case 'namespace'` |
| A3-A6      | `aggregateAnnotations` not wired to proxy tool registration                             | `src/server.ts` `registerProxyTool` |
| A7         | `[RO] ` prefix not applied when `config.readOnly === true` in proxy mode                | `src/server.ts` (search for `[RO]`) |
