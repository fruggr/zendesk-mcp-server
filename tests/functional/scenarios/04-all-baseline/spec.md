---
pr: 53
mode: all
read_only: false
namespaces: []
channels: [A]
---

# 04 — all (flat baseline, non-regression)

Sanity check that `--mode all` still exposes every individual tool with its
own `annotations` object intact (PR #53 must not regress flat mode).

## Steps

1. `pnpm build` if not already done.
2. Ensure `ZENDESK_SUBDOMAIN` is exported.
3. Dump:

   ```sh
   node tests/functional/bin/dump-tools-list.mjs --mode all \
     > tests/functional/reports/04-all-baseline.raw.json
   ```

4. Inspect the raw JSON. Confirm the tool count, sample a few entries (one
   read, one write, `manage_tags`), and verify no `[RO]` prefix anywhere.
5. Write the report at `tests/functional/reports/04-all-baseline.report.md`.

## Assertions to record

```json
{
  "scenario": "04-all-baseline",
  "mode": "all",
  "readOnly": false,
  "branch": "claude/laughing-lovelace-HmZOn",
  "assertions": [
    { "id": "A1", "desc": "tools/list returns exactly 39 entries",                                   "pass": null, "actual": null },
    { "id": "A2", "desc": "every entry has a non-empty annotations object",                          "pass": null, "actual": null },
    { "id": "A3", "desc": "every entry has openWorldHint=true",                                      "pass": null, "actual": null },
    { "id": "A4", "desc": "get_current_user has readOnlyHint=true and destructiveHint=false",        "pass": null, "actual": null },
    { "id": "A5", "desc": "manage_tags has destructiveHint=true",                                    "pass": null, "actual": null },
    { "id": "A6", "desc": "no description starts with '[RO] '",                                      "pass": null, "actual": null }
  ],
  "summary": "<one-line synthesis>"
}
```

## When done

1. Update `STATE.md`.
2. Commit and push.
3. Notify.
