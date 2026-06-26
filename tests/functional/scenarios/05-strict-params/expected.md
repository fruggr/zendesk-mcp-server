# Expected — 05-strict-params

Ground truth captured from `tools/list --mode all` on branch
`claude/issue-100-analysis-tj9dq9` (PR #102). Do not open this file as the
executor — it is the verdict criterion.

| ID | Expected |
| -- | -------- |
| S1 | `tools/list` returns **38** entries, and **all 38** have `inputSchema.additionalProperties === false` — including zero-parameter tools such as `get_current_user` (`inputSchema: {type:"object", properties:{}, additionalProperties:false}`). A count below 38, or any entry missing the key / not `false`, is a FAIL. (Total is allowed to drift if the tool surface changed; the load-bearing part is **every** entry having `additionalProperties:false`.) |
| S2 | `list_tickets` → `inputSchema.properties.page_size.description` === `"Tickets per page (1-100, default 100)."` (non-empty is the bar; exact string here for reference). |
| S3 | `list_tickets` → `inputSchema.properties.cursor.description` === `"Pagination cursor from a previous response; omit for the first page."` Must convey "omit for the first page"; the bare old value `"Pagination cursor"` is a FAIL. |
| S4 | `list_tickets` → top-level `description` contains both the substring `page_size` and the substring `per_page`. Exact text: `"List tickets with cursor-based pagination, sorted by most recently updated. Page size is controlled by page_size (not per_page, which is the offset-based parameter used by search_tickets); paginate by passing the returned cursor."` |
| S5 | `list_articles` → `inputSchema.properties.page_size.description` === `"Articles per page (1-100, default 100)."` (non-empty is the bar). |

## Verdict rule

All five OK → scenario `OK`. S1 is the load-bearing assertion (the strict
contract); S2–S5 confirm the documentation remediation. Any FAIL → scenario
`FAIL` with the failing IDs and a pointer to `src/server.ts` (strict
registration) or the relevant tool schema.
