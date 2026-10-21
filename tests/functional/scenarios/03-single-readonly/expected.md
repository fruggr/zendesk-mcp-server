# ⚠️ LEADING LLM ONLY — DO NOT READ IF YOU ARE THE EXECUTOR

---

## Expected values

- **A1.** `tools.length === 2`.
- **A2.** Names `zendesk` and `connector_preferences` (`registerSingleProxies` in `src/server.ts`: the preferences configure this server, not Zendesk, so they keep their own proxy).
- **A3-A5.** On `zendesk`, all read-only flags true. In `--read-only` mode the filter strips every Zendesk write op, so the aggregate trivially satisfies `every read-only / not destructive / every idempotent`.
- **A6.** `openWorldHint=true` on `zendesk`.
- **A7.** `zendesk` description starts with `[RO]`.
- **A8.** `connector_preferences`: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`; description does **not** start with `[RO]`.

## Failure diagnostics

| If FAIL on | Likely cause                                                              | Where to look                       |
| ---------- | ------------------------------------------------------------------------- | ----------------------------------- |
| A1, A2     | Single-mode registration broken                                           | `src/server.ts` `registerSingleProxies` |
| A3-A6      | `aggregateAnnotations` not applied to single proxy                        | `src/server.ts` `registerProxyTool` |
| A7         | `[RO]` prefix logic skipped for single mode, or preferences folded into `zendesk` | `src/server.ts` `registerProxyTool`, `registerSingleProxies` |
| A8         | Preferences proxy announced as read-only                                  | `src/tools/preferences.ts`          |
