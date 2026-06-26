---
pr: 102
mode: all
read_only: false
namespaces: []
channels: [A]
---

# 05 — strict params + pagination docs (PR #102, issue #100)

PR #102 makes the server reject unknown/mistyped tool parameters instead of
silently dropping them, and documents the cursor pagination parameters. In
`--mode all` the server now registers the **strict** Zod schema with the SDK, so
every advertised `inputSchema` must carry `additionalProperties: false` — the
wire-level proof that an unknown key (e.g. `per_page` on `list_tickets`, whose
real parameter is `page_size`) will be refused. This scenario validates that
contract over `tools/list`.

Runtime rejection of an unknown key (`tools/call` → error) is already covered by
the integration suite (`tests/integration/core-scenarios.ts`); this channel-A
scenario validates the advertised schema and the new parameter docs.

## Steps

1. `pnpm build` if not already done.
2. Ensure `ZENDESK_SUBDOMAIN` is exported (no Zendesk call fires — `tools/list`
   does not authenticate).
3. Dump:

   ```sh
   node tests/functional/bin/dump-tools-list.mjs --mode all \
     > tests/functional/reports/05-strict-params.raw.json
   ```

4. Inspect the raw JSON:
   - count the entries and how many have `inputSchema.additionalProperties === false`;
   - read `list_tickets` (its `description`, and `inputSchema.properties.page_size.description`
     and `.cursor.description`);
   - read `list_articles` `inputSchema.properties.page_size.description`.
5. Write the report at `tests/functional/reports/05-strict-params.report.md`,
   filling in the `pass`/`actual` fields of the fence below from the raw JSON.

## Assertions to record

```json
{
  "scenario": "05-strict-params",
  "mode": "all",
  "readOnly": false,
  "branch": "claude/issue-100-analysis-tj9dq9",
  "assertions": [
    { "id": "S1", "desc": "every tools/list entry has inputSchema.additionalProperties === false (report the count of entries and how many satisfy this)", "pass": null, "actual": null },
    { "id": "S2", "desc": "list_tickets inputSchema.properties.page_size has a non-empty description",                                                       "pass": null, "actual": null },
    { "id": "S3", "desc": "list_tickets inputSchema.properties.cursor description tells the caller to omit it for the first page",                            "pass": null, "actual": null },
    { "id": "S4", "desc": "list_tickets top-level description mentions both 'page_size' and 'per_page' (clarifying which to use)",                            "pass": null, "actual": null },
    { "id": "S5", "desc": "list_articles inputSchema.properties.page_size has a non-empty description",                                                       "pass": null, "actual": null }
  ],
  "summary": "<one-line synthesis>"
}
```

## When done

1. Update `STATE.md` (status=done, holder=leading).
2. Commit and push.
3. Notify.
