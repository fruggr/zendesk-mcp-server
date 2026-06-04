# ⚠️ LEADING LLM ONLY — DO NOT READ IF YOU ARE THE EXECUTOR

---

## Expected values

- **A1.** `tools.length === 1`.
- **A2.** `tools[0].name === 'zendesk'` (hard-coded in `src/server.ts` `case 'single'`).
- **A3-A5.** All read-only flags true. In `--read-only` mode the filter strips every write op, so the aggregate trivially satisfies `every read-only / not destructive / every idempotent`.
- **A6.** `openWorldHint=true` (hard-coded in `aggregateAnnotations`).
- **A7.** Description starts with `[RO]`.

## Failure diagnostics

| If FAIL on | Likely cause                                                              | Where to look                       |
| ---------- | ------------------------------------------------------------------------- | ----------------------------------- |
| A1, A2     | Single-mode registration broken                                           | `src/server.ts` `case 'single'`     |
| A3-A6      | `aggregateAnnotations` not applied to single proxy                        | `src/server.ts` `registerProxyTool` |
| A7         | `[RO]` prefix logic skipped for single mode                              | `src/server.ts` `registerProxyTool` |
