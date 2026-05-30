# ⚠️ LEADING LLM ONLY — DO NOT READ IF YOU ARE THE EXECUTOR

---

## Expected values

- **A1.** `tools.length === 37`. Breakdown: 10 ticket tools + 21 Help Center
  tools + 5 user/organization tools + 1 unified search tool. If the count
  drifts, update the documentation listed in `AGENTS.md` "Documentation
  maintenance" before running.
- **A2.** Every entry must have a populated `annotations` object — no
  `undefined`, no empty `{}`.
- **A3.** `openWorldHint=true` everywhere (every tool hits Zendesk over the
  network).
- **A4.** `get_current_user`: read-only and non-destructive (sanity sample).
- **A5.** `manage_tags.destructiveHint=true` — verified by the previous PR
  (commit `10d846b`). Guards against a regression of that fix.
- **A6.** `[RO] ` prefix is a proxy-mode-only feature; in `--mode all` no
  description should carry it.

## Failure diagnostics

| If FAIL on | Likely cause                                                              | Where to look                       |
| ---------- | ------------------------------------------------------------------------- | ----------------------------------- |
| A1         | Tool added/removed without doc sync, or registry drift                    | `AGENTS.md` "Documentation maintenance", `src/tools/index.ts` |
| A2, A3     | `createAllTools` skipped annotations on a new tool                        | per-namespace `src/tools/*.ts`      |
| A4, A5     | Annotation regression on a specific tool                                  | `src/tools/users.ts`, `src/tools/tickets.ts` (search `manage_tags`) |
| A6         | `[RO] ` prefix leaked into individual tool descriptions                   | `src/server.ts` `case 'all'`        |
