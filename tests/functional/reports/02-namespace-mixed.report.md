# Report — 02-namespace-mixed

Mode `namespace` (no `--read-only`). Dumped `tools/list` into
`02-namespace-mixed.raw.json`. The server registered 37 underlying tools and
exposed **3 proxy tools**. No `[RO] ` prefix anywhere. Annotations aggregate
per namespace: a namespace with at least one write op reports
`readOnlyHint=false, destructiveHint=true`; an all-read namespace
(`zendesk_users`) keeps `readOnlyHint=true, destructiveHint=false`.

Observations (verbatim from `raw.json`):

- `.tools[]` length = 3.
- `zendesk_tickets`: `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }`.
- `zendesk_help_center`: `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }`.
- `zendesk_users`: `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }`.
- No description begins with `"[RO] "`.

```json
{
  "scenario": "02-namespace-mixed",
  "mode": "namespace",
  "readOnly": false,
  "branch": "claude/laughing-lovelace-HmZOn",
  "assertions": [
    { "id": "A1", "desc": "tools/list returns exactly 3 entries",                                       "pass": true, "actual": "3 entries" },
    { "id": "A2", "desc": "zendesk_tickets has readOnlyHint=false and destructiveHint=true",            "pass": true, "actual": "readOnlyHint=false, destructiveHint=true" },
    { "id": "A3", "desc": "zendesk_help_center has readOnlyHint=false and destructiveHint=true",        "pass": true, "actual": "readOnlyHint=false, destructiveHint=true" },
    { "id": "A4", "desc": "zendesk_users has readOnlyHint=true and destructiveHint=false",              "pass": true, "actual": "readOnlyHint=true, destructiveHint=false" },
    { "id": "A5", "desc": "every tool has openWorldHint=true",                                          "pass": true, "actual": "all 3 openWorldHint=true" },
    { "id": "A6", "desc": "no tool description starts with '[RO] '",                                    "pass": true, "actual": "0 of 3 descriptions have the [RO] prefix" }
  ],
  "summary": "green — 3 proxies, write namespaces destructive, users read-only, no [RO] prefix"
}
```
