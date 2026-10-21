---
pr: 53
mode: single
read_only: true
namespaces: []
channels: [A]
---

# 03 — single + read-only

Verify the single-proxy mode in read-only: one Zendesk tool, aggregated
annotations across all read ops, `[RO]` prefix; the connector preferences keep
their own proxy beside it.

## Steps

1. `pnpm build` if not already done.
2. Ensure `ZENDESK_SUBDOMAIN` is exported.
3. Dump:

   ```sh
   node tests/functional/bin/dump-tools-list.mjs --mode single --read-only \
     > tests/functional/reports/03-single-readonly.raw.json
   ```

4. Inspect the tools and write the report at
   `tests/functional/reports/03-single-readonly.report.md`.

## Assertions to record

```json
{
  "scenario": "03-single-readonly",
  "mode": "single",
  "readOnly": true,
  "branch": "claude/laughing-lovelace-HmZOn",
  "assertions": [
    { "id": "A1", "desc": "tools/list returns exactly 2 entries",                "pass": null, "actual": null },
    { "id": "A2", "desc": "the tool names are {'zendesk', 'connector_preferences'}", "pass": null, "actual": null },
    { "id": "A3", "desc": "zendesk: annotations.readOnlyHint === true",          "pass": null, "actual": null },
    { "id": "A4", "desc": "zendesk: annotations.destructiveHint === false",      "pass": null, "actual": null },
    { "id": "A5", "desc": "zendesk: annotations.idempotentHint === true",        "pass": null, "actual": null },
    { "id": "A6", "desc": "zendesk: annotations.openWorldHint === true",         "pass": null, "actual": null },
    { "id": "A7", "desc": "zendesk: description starts with the literal '[RO] '", "pass": null, "actual": null },
    { "id": "A8", "desc": "connector_preferences: readOnlyHint, destructiveHint, idempotentHint, openWorldHint, and whether its description starts with '[RO]'", "pass": null, "actual": null }
  ],
  "summary": "<one-line synthesis>"
}
```

## When done

1. Update `STATE.md`.
2. Commit and push.
3. Notify.
