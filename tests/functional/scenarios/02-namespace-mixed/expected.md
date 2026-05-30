# ⚠️ LEADING LLM ONLY — DO NOT READ IF YOU ARE THE EXECUTOR

---

## Expected values

- **A1.** `tools.length === 3`, names `{zendesk_tickets, zendesk_help_center, zendesk_users}`.
- **A2.** `zendesk_tickets` aggregates writes (e.g. `create_ticket`, `update_ticket`, `manage_tags`), so `readOnlyHint=false` and `destructiveHint=true`.
- **A3.** `zendesk_help_center` aggregates writes (article/section edits), so `readOnlyHint=false` and `destructiveHint=true`.
- **A4.** `zendesk_users` is fully read-only by construction (all 5 sub-tools have `readOnly: true` in `src/tools/users.ts`). The aggregate keeps `readOnlyHint=true`, `destructiveHint=false`. **This is the load-bearing assertion of this scenario** — confirms aggregation is "every"/"some" semantics, not blanket-off-when-not-in-`--read-only`.
- **A5.** `openWorldHint=true` is hard-coded in `aggregateAnnotations`.
- **A6.** No description starts with `[RO] ` — the prefix only applies when the server runs with `--read-only`.

## Failure diagnostics

| If FAIL on | Likely cause                                                                                | Where to look                          |
| ---------- | ------------------------------------------------------------------------------------------- | -------------------------------------- |
| A2, A3     | `aggregateAnnotations` semantics regressed (e.g. swapped `every`/`some`)                    | `src/server.ts` `aggregateAnnotations` |
| A4         | Aggregation now hard-codes `readOnlyHint=false` outside `--read-only` (regression)          | `src/server.ts` `aggregateAnnotations` |
| A6         | `[RO] ` prefix leaked into non-read-only mode                                               | `src/server.ts` `registerProxyTool`    |
