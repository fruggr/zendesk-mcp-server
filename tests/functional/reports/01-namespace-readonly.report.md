# Report — 01-namespace-readonly

Mode `namespace --read-only`. Dumped `tools/list` via
`bin/dump-tools-list.mjs` into `01-namespace-readonly.raw.json`. The server
registered 25 underlying read-only tools (stderr log) and exposed **3 proxy
tools**. Each proxy carries the aggregated read-only annotation set and a
`[RO] ` description prefix.

Observations (verbatim from `raw.json`):

- `.tools[]` length = 3 → `zendesk_tickets`, `zendesk_help_center`, `zendesk_users`.
- All three annotations objects are identical:
  `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }`.
- All three descriptions begin with the literal `"[RO] "`.

```json
{
  "scenario": "01-namespace-readonly",
  "mode": "namespace",
  "readOnly": true,
  "branch": "claude/laughing-lovelace-HmZOn",
  "assertions": [
    { "id": "A1", "desc": "tools/list returns exactly 3 entries",                          "pass": true, "actual": "3 entries" },
    { "id": "A2", "desc": "tool names are {zendesk_tickets, zendesk_help_center, zendesk_users}", "pass": true, "actual": "zendesk_tickets, zendesk_help_center, zendesk_users" },
    { "id": "A3", "desc": "every tool has annotations.readOnlyHint === true",              "pass": true, "actual": "all 3 readOnlyHint=true" },
    { "id": "A4", "desc": "every tool has annotations.destructiveHint === false",          "pass": true, "actual": "all 3 destructiveHint=false" },
    { "id": "A5", "desc": "every tool has annotations.idempotentHint === true",            "pass": true, "actual": "all 3 idempotentHint=true" },
    { "id": "A6", "desc": "every tool has annotations.openWorldHint === true",             "pass": true, "actual": "all 3 openWorldHint=true" },
    { "id": "A7", "desc": "every tool description starts with the literal '[RO] '",        "pass": true, "actual": "all 3 descriptions start with '[RO] '" }
  ],
  "summary": "green — 3 read-only proxies, aggregated read-only annotations, [RO] prefix on all"
}
```
