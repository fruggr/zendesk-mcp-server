---
pr: 53
mode: namespace
read_only: true
namespaces: []
channels: [A]
---

# 01 — namespace + read-only

Verify that proxy tools in `--mode namespace --read-only` expose correct
aggregated annotations and a `[RO] ` description prefix.

## Steps

1. Make sure you've built once on this branch: `pnpm build`.
2. Make sure `ZENDESK_SUBDOMAIN` is exported (see `tests/functional/README.md`).
3. Dump `tools/list` to `reports/01-namespace-readonly.raw.json`:

   ```sh
   node tests/functional/bin/dump-tools-list.mjs \
     --mode namespace --read-only \
     > tests/functional/reports/01-namespace-readonly.raw.json
   ```

4. Open the raw JSON. Inspect each tool entry under `.tools[]`. Look at
   `name`, `description` (first ~20 chars), and the full `annotations` object.
5. Fill in the report below at
   `tests/functional/reports/01-namespace-readonly.report.md`.

## Assertions to record

For each assertion, set `pass: true|false`, fill `actual` with the value you
observed in the raw JSON, and copy the `desc` verbatim. **Do not** look up
expected values — `expected.md` is off-limits to you.

```json
{
  "scenario": "01-namespace-readonly",
  "mode": "namespace",
  "readOnly": true,
  "branch": "claude/laughing-lovelace-HmZOn",
  "assertions": [
    { "id": "A1", "desc": "tools/list returns exactly 3 entries",                          "pass": null, "actual": null },
    { "id": "A2", "desc": "tool names are {zendesk_tickets, zendesk_help_center, zendesk_users}", "pass": null, "actual": null },
    { "id": "A3", "desc": "every tool has annotations.readOnlyHint === true",              "pass": null, "actual": null },
    { "id": "A4", "desc": "every tool has annotations.destructiveHint === false",          "pass": null, "actual": null },
    { "id": "A5", "desc": "every tool has annotations.idempotentHint === true",            "pass": null, "actual": null },
    { "id": "A6", "desc": "every tool has annotations.openWorldHint === true",             "pass": null, "actual": null },
    { "id": "A7", "desc": "every tool description starts with the literal '[RO] '",        "pass": null, "actual": null }
  ],
  "summary": "<one-line synthesis: green / which IDs failed>"
}
```

## When done

1. Update `tests/functional/STATE.md`: set this scenario `status: done`,
   bump `holder` to `leading`.
2. `git add tests/functional/reports/01-namespace-readonly.* tests/functional/STATE.md`.
3. Commit with `test(functional): run scenario 01-namespace-readonly` and push.
4. Notify the leading LLM in chat.
