---
pr: 329
mode: namespace
read_only: false
namespaces: []
channels: [A]
---

# 07 — proxy parameter names (issue #329)

Proxies (`namespace` / `single` mode) now carry each operation's parameter names
in the `operation` input property, and keep their tool description short. This
scenario checks the wire output, then checks that a real client hands the
names to its model. Re-run it after a Claude Code upgrade.

## Steps

1. `pnpm build` if not already done. Export `ZENDESK_SUBDOMAIN`. `tools/list`
   does not authenticate, so no Zendesk call fires.
2. Dump both modes:

   ```sh
   node tests/functional/bin/dump-tools-list.mjs --mode namespace \
     > tests/functional/reports/07-proxy-param-names.namespace.raw.json
   node tests/functional/bin/dump-tools-list.mjs --mode single \
     > tests/functional/reports/07-proxy-param-names.single.raw.json
   ```

3. In each dump, for every proxy record: the `description` length, its last
   line, and the `inputSchema.properties.operation.description` and
   `.params.description` texts.
4. Client perception. Write an MCP config that runs `node dist/index.js --mode
   namespace` with your `ZENDESK_SUBDOMAIN`, then run:

   ```sh
   claude -p "Do not call any tool except ToolSearch to load schemas. From the zendesk_help_center tool definition alone, list (1) every operation name it offers, and (2) the exact parameter names of create_article, get_article_section and update_article_section, marking which are required." \
     --mcp-config <your-config.json> --strict-mcp-config --allowedTools ToolSearch < /dev/null
   ```

   Paste the answer verbatim under a `## perception` heading in the report.
5. Run `node scripts/probe-mcp-description-cap.mjs` and paste its last eight
   lines under a `## probe` heading.
6. Write `tests/functional/reports/07-proxy-param-names.report.md`, filling the
   fence below.

## Assertions to record

```json
{
  "scenario": "07-proxy-param-names",
  "mode": "namespace",
  "readOnly": false,
  "assertions": [
    { "id": "P1", "desc": "every proxy description in both dumps is at most 2048 characters (report each length)", "pass": null, "actual": null },
    { "id": "P2", "desc": "every proxy description ends with an 'Operations:' line naming its operations", "pass": null, "actual": null },
    { "id": "P3", "desc": "zendesk_help_center's operation field has one line per operation, each shaped name(params): summary", "pass": null, "actual": null },
    { "id": "P4", "desc": "the create_article line lists label_names; the get_article_section line lists section_index; the update_article_section line lists content (report the three lines)", "pass": null, "actual": null },
    { "id": "P5", "desc": "the single-mode operation field lists as many lines as all namespace proxies together", "pass": null, "actual": null },
    { "id": "P6", "desc": "perception: the model lists every help_center operation and the exact parameter names of the three operations", "pass": null, "actual": null },
    { "id": "P7", "desc": "probe: the script ends with OK", "pass": null, "actual": null }
  ],
  "summary": "<one-line synthesis: green / which IDs failed>"
}
```
