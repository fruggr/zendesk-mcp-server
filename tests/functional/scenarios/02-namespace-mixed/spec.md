---
pr: 53
mode: namespace
read_only: false
namespaces: []
channels: [A]
---

# 02 — namespace, mixed (no read-only)

Verify that proxy tools in `--mode namespace` (without `--read-only`) expose
correct aggregated annotations and **no** `[RO] ` prefix. Proxies that
aggregate at least one write op must report `destructiveHint: true`. Proxies
whose sub-tools are all read-only (e.g. `zendesk_users`) must keep
`readOnlyHint: true`.

## Steps

1. `pnpm build` if not already done on this branch.
2. Ensure `ZENDESK_SUBDOMAIN` is exported.
3. Dump:

   ```sh
   node tests/functional/bin/dump-tools-list.mjs --mode namespace \
     > tests/functional/reports/02-namespace-mixed.raw.json
   ```

4. Inspect annotations per tool. Write the report at
   `tests/functional/reports/02-namespace-mixed.report.md`.

## Assertions to record

```json
{
  "scenario": "02-namespace-mixed",
  "mode": "namespace",
  "readOnly": false,
  "branch": "claude/laughing-lovelace-HmZOn",
  "assertions": [
    { "id": "A1", "desc": "tools/list returns exactly 3 entries",                                       "pass": null, "actual": null },
    { "id": "A2", "desc": "zendesk_tickets has readOnlyHint=false and destructiveHint=true",            "pass": null, "actual": null },
    { "id": "A3", "desc": "zendesk_help_center has readOnlyHint=false and destructiveHint=true",        "pass": null, "actual": null },
    { "id": "A4", "desc": "zendesk_users has readOnlyHint=true and destructiveHint=false",              "pass": null, "actual": null },
    { "id": "A5", "desc": "every tool has openWorldHint=true",                                          "pass": null, "actual": null },
    { "id": "A6", "desc": "no tool description starts with '[RO] '",                                    "pass": null, "actual": null }
  ],
  "summary": "<one-line synthesis>"
}
```

## When done

1. Update `STATE.md`: `02-namespace-mixed` → `done`, `holder` → `leading`.
2. Commit `tests/functional/reports/02-namespace-mixed.*` and `STATE.md`.
3. Push and notify.
