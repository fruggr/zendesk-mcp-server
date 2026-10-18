# ⚠️ LEADING LLM ONLY — DO NOT READ IF YOU ARE THE EXECUTOR

Reading this file biases the report. Stop now and read only `spec.md`.

---

## Expected values (verdict criteria)

- **A1 — count.** `result.tools.length === 4`.
- **A2 — names.** Set equality with `{"zendesk_tickets", "zendesk_help_center", "zendesk_users", "connector_preferences"}`. Order is irrelevant. `connector_preferences` survives `--read-only`, which means "no Zendesk writes": it writes this server's own settings.
- **A3 — readOnlyHint.** `true` on the 3 `zendesk_*` proxies.
- **A4 — destructiveHint.** `false` on the 3. (Aggregation: `some` of zero destructive ops is `false`. In read-only mode, every Zendesk sub-tool is read-only by construction.)
- **A5 — idempotentHint.** `true` on the 3. (Every read op is idempotent.)
- **A6 — openWorldHint.** `true` on the 3 (every Zendesk op is open-world; `aggregateAnnotations` ORs it).
- **A7 — `[RO]` prefix.** Each `zendesk_*` description must literally start with the 5
  characters `[` `R` `O` `]` ` ` (bracket-R-O-bracket-space).
- **A8 — connector_preferences.** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`; description does **not** start with `[RO]`.

## Failure diagnostics

| If FAIL on | Likely cause                                                                            | Where to look                     |
| ---------- | --------------------------------------------------------------------------------------- | --------------------------------- |
| A1, A2     | Routing filter broken or namespace registration regressed                               | `src/routing/registry.ts`, `src/server.ts` `case 'namespace'` |
| A3-A6      | `aggregateAnnotations` not wired to proxy tool registration                             | `src/server.ts` `registerProxyTool` |
| A7         | `[RO]` prefix not applied when `config.readOnly === true` in proxy mode                | `src/server.ts` (search for `[RO]`) |
| A8         | Preferences proxy announced as read-only, or dropped by `--read-only`                   | `src/server.ts` `registerProxyTool`, `src/tools/preferences.ts` |
