# Report — 04-all-baseline

Mode `all`. Dumped `tools/list` into `04-all-baseline.raw.json`. The server
registered and exposed **37 individual tools**, each with its own non-empty
`annotations` object intact. No proxy, no `[RO] ` prefix anywhere — flat mode
is not regressed by PR #53.

Observations (verbatim from `raw.json`):

- `.tools[]` length = 37.
- 0 entries have an empty/missing `annotations` object (all 37 non-empty).
- All 37 entries have `openWorldHint=true`.
- `get_current_user`: `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }`.
- `manage_tags`: `{ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }` → `destructiveHint=true`.
- 0 descriptions begin with `"[RO] "`.

```json
{
  "scenario": "04-all-baseline",
  "mode": "all",
  "readOnly": false,
  "branch": "claude/laughing-lovelace-HmZOn",
  "assertions": [
    { "id": "A1", "desc": "tools/list returns exactly 37 entries",                                   "pass": true, "actual": "37 entries" },
    { "id": "A2", "desc": "every entry has a non-empty annotations object",                          "pass": true, "actual": "0 of 37 entries have empty/missing annotations" },
    { "id": "A3", "desc": "every entry has openWorldHint=true",                                      "pass": true, "actual": "all 37 openWorldHint=true" },
    { "id": "A4", "desc": "get_current_user has readOnlyHint=true and destructiveHint=false",        "pass": true, "actual": "readOnlyHint=true, destructiveHint=false" },
    { "id": "A5", "desc": "manage_tags has destructiveHint=true",                                    "pass": true, "actual": "destructiveHint=true" },
    { "id": "A6", "desc": "no description starts with '[RO] '",                                      "pass": true, "actual": "0 of 37 descriptions have the [RO] prefix" }
  ],
  "summary": "green — 37 flat tools, every annotations object intact, no [RO] prefix"
}
```
