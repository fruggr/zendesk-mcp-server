# Report — 05-strict-params

Mode `all`, read-only off. Dumped `tools/list` into `05-strict-params.raw.json`
(server logged `tools_registered count=38 mode=all`). PR #102 registers the
**strict** Zod schema with the SDK, so every advertised `inputSchema` must carry
`additionalProperties: false` — the wire-level proof that an unknown key (e.g.
`per_page` on `list_tickets`, whose real parameter is `page_size`) is refused.
This channel-A scenario validates the advertised schema plus the new cursor
pagination docs. All five assertions are green.

Observations (verbatim from `raw.json`):

- `.tools[]` length = 38; **38 of 38** have `inputSchema.additionalProperties === false` (0 missing).
- `list_tickets` top-level `description`:
  `"List tickets with cursor-based pagination, sorted by most recently updated. Page size is controlled by page_size (not per_page, which is the offset-based parameter used by search_tickets); paginate by passing the returned cursor."`
  → mentions both `page_size` and `per_page`, clarifying which to use.
- `list_tickets.inputSchema.properties.page_size.description`:
  `"Tickets per page (1-100, default 100)."` → non-empty.
- `list_tickets.inputSchema.properties.cursor.description`:
  `"Pagination cursor from a previous response; omit for the first page."` → tells the caller to omit it for the first page.
- `list_articles.inputSchema.properties.page_size.description`:
  `"Articles per page (1-100, default 100)."` → non-empty.

```json
{
  "scenario": "05-strict-params",
  "mode": "all",
  "readOnly": false,
  "branch": "claude/issue-100-analysis-tj9dq9",
  "assertions": [
    { "id": "S1", "desc": "every tools/list entry has inputSchema.additionalProperties === false (report the count of entries and how many satisfy this)", "pass": true, "actual": "38 of 38 entries have additionalProperties===false (0 missing)" },
    { "id": "S2", "desc": "list_tickets inputSchema.properties.page_size has a non-empty description",                                                       "pass": true, "actual": "\"Tickets per page (1-100, default 100).\"" },
    { "id": "S3", "desc": "list_tickets inputSchema.properties.cursor description tells the caller to omit it for the first page",                            "pass": true, "actual": "\"Pagination cursor from a previous response; omit for the first page.\"" },
    { "id": "S4", "desc": "list_tickets top-level description mentions both 'page_size' and 'per_page' (clarifying which to use)",                            "pass": true, "actual": "description names page_size as the page-size control and per_page as the offset-based param used by search_tickets" },
    { "id": "S5", "desc": "list_articles inputSchema.properties.page_size has a non-empty description",                                                       "pass": true, "actual": "\"Articles per page (1-100, default 100).\"" }
  ],
  "summary": "green — 38/38 tools advertise additionalProperties:false, and list_tickets/list_articles carry the documented page_size/cursor pagination params"
}
```
