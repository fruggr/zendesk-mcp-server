# Report — 03-single-readonly

Mode `single --read-only`. Dumped `tools/list` into
`03-single-readonly.raw.json`. The server registered 25 underlying read-only
tools and exposed **1 proxy tool** named `zendesk`, aggregating all read ops
with a `[RO] ` description prefix.

Observations (verbatim from `raw.json`):

- `.tools[]` length = 1.
- `.tools[0].name` = `"zendesk"`.
- `.tools[0].annotations` = `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }`.
- `.tools[0].description` begins with `"[RO] "`.

```json
{
  "scenario": "03-single-readonly",
  "mode": "single",
  "readOnly": true,
  "branch": "claude/laughing-lovelace-HmZOn",
  "assertions": [
    { "id": "A1", "desc": "tools/list returns exactly 1 entry",                  "pass": true, "actual": "1 entry" },
    { "id": "A2", "desc": "the tool name is exactly 'zendesk'",                  "pass": true, "actual": "zendesk" },
    { "id": "A3", "desc": "annotations.readOnlyHint === true",                   "pass": true, "actual": "readOnlyHint=true" },
    { "id": "A4", "desc": "annotations.destructiveHint === false",               "pass": true, "actual": "destructiveHint=false" },
    { "id": "A5", "desc": "annotations.idempotentHint === true",                 "pass": true, "actual": "idempotentHint=true" },
    { "id": "A6", "desc": "annotations.openWorldHint === true",                  "pass": true, "actual": "openWorldHint=true" },
    { "id": "A7", "desc": "description starts with the literal '[RO] '",        "pass": true, "actual": "description starts with '[RO] '" }
  ],
  "summary": "green — single 'zendesk' proxy, read-only annotations, [RO] prefix"
}
```
