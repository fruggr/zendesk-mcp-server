---
pr: 264
mode: namespace
read_only: false
namespaces: [requests]
channels: [A]
---

# 06 — requests namespace (end-user surface, opt-in)

Verify at the wire level that the end-user request surface is **opt-in**: absent
from the default `tools/list`, present and complete when `--namespace requests`
is passed, and that its descriptions disambiguate it from the agent ticket
tools it sits beside.

## Steps

1. Make sure you've built once on this branch: `pnpm build`.
2. Make sure `ZENDESK_SUBDOMAIN` is exported (see `tests/functional/README.md`).
3. Dump **three** listings:

   ```sh
   # a) the default surface — the end-user proxy must NOT be here
   node tests/functional/bin/dump-tools-list.mjs \
     > tests/functional/reports/06-requests-namespace.default.raw.json

   # b) the opt-in surface, proxied
   node tests/functional/bin/dump-tools-list.mjs --namespace requests \
     > tests/functional/reports/06-requests-namespace.raw.json

   # c) the opt-in surface, flat, so every tool's own schema is visible
   node tests/functional/bin/dump-tools-list.mjs --namespace requests --mode all \
     > tests/functional/reports/06-requests-namespace.flat.raw.json
   ```

4. Also run the diagnostic flag and paste its output verbatim into the report —
   it needs no credential and makes no network call:

   ```sh
   node dist/index.js "$ZENDESK_SUBDOMAIN" --print-tools --namespace requests
   ```

5. Inspect the JSON. For (c), look at each entry's `name`, `description` and
   `inputSchema`.
6. Fill in the report at
   `tests/functional/reports/06-requests-namespace.report.md`.

## Assertions to record

For each assertion, set `pass: true|false`, fill `actual` with the value you
observed, and copy the `desc` verbatim. **Do not** look up expected values —
`expected.md` is off-limits to you.

```json
{
  "scenario": "06-requests-namespace",
  "mode": "namespace",
  "readOnly": false,
  "namespaces": ["requests"],
  "branch": "claude/issue-48-analysis-czaqzt",
  "assertions": [
    { "id": "A1", "desc": "in the DEFAULT listing (a), no tool is named zendesk_requests",             "pass": null, "actual": null },
    { "id": "A2", "desc": "in the DEFAULT listing (a), the tool count is unchanged from scenario 02",  "pass": null, "actual": null },
    { "id": "A3", "desc": "with --namespace requests (b), tools/list returns exactly 1 entry named zendesk_requests", "pass": null, "actual": null },
    { "id": "A4", "desc": "that proxy's description lists exactly 7 operations",                        "pass": null, "actual": null },
    { "id": "A5", "desc": "the operation names are list_request_forms, get_request_form, create_request, list_requests, get_request, add_request_comment, mark_request_solved", "pass": null, "actual": null },
    { "id": "A6", "desc": "exactly 3 of those operations are marked (write) in the proxy description", "pass": null, "actual": null },
    { "id": "A7", "desc": "in flat mode (c), every entry has inputSchema.additionalProperties === false", "pass": null, "actual": null },
    { "id": "A8", "desc": "in flat mode (c), every parameter of every entry has a non-empty description", "pass": null, "actual": null },
    { "id": "A9", "desc": "each of the 7 descriptions' FIRST sentence makes clear it acts on the caller's own requests, not an agent queue", "pass": null, "actual": null },
    { "id": "A10", "desc": "mark_request_solved's description states that it is refused when the request is not solvable by its requester", "pass": null, "actual": null },
    { "id": "A11", "desc": "add_request_comment's description states that replying to a solved request reopens it", "pass": null, "actual": null },
    { "id": "A12", "desc": "--print-tools output names zendesk_requests and its 7 operations, with no network call and no auth prompt", "pass": null, "actual": null }
  ],
  "summary": "<one-line synthesis: green / which IDs failed>"
}
```

Record the `--print-tools` output verbatim under a `## print-tools` heading in
the report — it is the artifact for A12.

## When done

1. Update `tests/functional/STATE.md`: set this scenario `status: done`,
   bump `holder` to `leading`.
2. `git add tests/functional/reports/06-requests-namespace.* tests/functional/STATE.md`.
3. Commit with `test(functional): run scenario 06-requests-namespace` and push.
4. Notify the leading LLM in chat.
