---
pr: 53
mode: single
read_only: true
namespaces: []
channels: [A]
---

# 03 — single + read-only

Verify the single-proxy mode in read-only: one tool, aggregated annotations
across all read ops, `[RO]` prefix.

## Steps

1. `pnpm build` if not already done.
2. Ensure `ZENDESK_SUBDOMAIN` is exported.
3. Dump:

   ```sh
   node tests/functional/bin/dump-tools-list.mjs --mode single --read-only \
     > tests/functional/reports/03-single-readonly.raw.json
   ```

4. Inspect the single tool and write the report at
   `tests/functional/reports/03-single-readonly.report.md`.

## Assertions to record

```json
{
  "scenario": "03-single-readonly",
  "mode": "single",
  "readOnly": true,
  "branch": "claude/laughing-lovelace-HmZOn",
  "assertions": [
    { "id": "A1", "desc": "tools/list returns exactly 1 entry",                  "pass": null, "actual": null },
    { "id": "A2", "desc": "the tool name is exactly 'zendesk'",                  "pass": null, "actual": null },
    { "id": "A3", "desc": "annotations.readOnlyHint === true",                   "pass": null, "actual": null },
    { "id": "A4", "desc": "annotations.destructiveHint === false",               "pass": null, "actual": null },
    { "id": "A5", "desc": "annotations.idempotentHint === true",                 "pass": null, "actual": null },
    { "id": "A6", "desc": "annotations.openWorldHint === true",                  "pass": null, "actual": null },
    { "id": "A7", "desc": "description starts with the literal '[RO] '",        "pass": null, "actual": null }
  ],
  "summary": "<one-line synthesis>"
}
```

## When done

1. Update `STATE.md`.
2. Commit and push.
3. Notify.
