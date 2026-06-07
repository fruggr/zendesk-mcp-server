# Functional test harness

End-to-end behavioural tests for the MCP server, driven by **two LLMs
communicating through committed files**. Designed to validate features that
unit tests can't reach: the actual wire-level output of `tools/list`,
real `tools/call` round-trips, client-visible annotations, description
strings, etc.

## Roles

| Role                  | Lives in       | Reads                                                          | Writes                                                              |
| --------------------- | -------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Leading LLM**       | Web Claude     | `scenarios/<N>/spec.md`, `scenarios/<N>/expected.md`, reports  | `STATE.md`, `reports/<N>.verdict.md`, optional code fixes           |
| **Executing LLM**     | Local Claude   | `scenarios/<N>/spec.md`, `STATE.md`                            | `reports/<N>.raw.json`, `reports/<N>.report.md`, `STATE.md`         |

`scenarios/` is read-only for the executor. `reports/` is the comm channel.
`STATE.md` is shared, but the `holder` field acts as a narrative lock — only
the holder pushes.

**Critical:** the executor must NOT open `expected.md`. It encodes the verdict
criteria — seeing it would bias the report.

## Channels

Each scenario declares which channels it uses in its frontmatter (`channels`):

- **A — Subprocess `tools/list`.** Executor runs
  `bin/dump-tools-list.mjs` which spawns the local server build and dumps
  `tools/list` as canonical JSON. No Zendesk network call (auth only fires on
  `tools/call`). All current scenarios use channel A.
- **B — MCP Zendesk in the executor's Claude Code stack.** For future
  scenarios that exercise runtime behaviour (e.g. a new tool, proxy routing).
  Requires the executor to have configured a Zendesk MCP server locally
  pointing at the `fruggr` instance. Not exercised by the v1 scenarios.

## Prerequisites (executor side)

1. Build the server once: `pnpm build`.
2. Source the local Zendesk credentials (perso, never commit):
   ```sh
   export ZENDESK_SUBDOMAIN=fruggr
   # ZENDESK_OAUTH_CLIENT_ID defaults to ${subdomain}_zendesk; override if needed
   ```
3. For channel B scenarios only: ensure your Claude Code MCP config exposes a
   Zendesk server bound to `fruggr`.

## Adding a scenario for a future PR

1. Create `scenarios/<NN>-<slug>/spec.md` with frontmatter:
   ```yaml
   ---
   pr: <number>
   mode: namespace | single | all
   read_only: true | false
   namespaces: []          # optional --namespace filters
   channels: [A]           # or [A, B]
   ---
   ```
2. Body of `spec.md`: the exact commands to run, the artifacts to write, the
   assertion fence template (IDs + descriptions, no expected values).
3. Create `scenarios/<NN>-<slug>/expected.md` with a header banner warning the
   executor not to open it, then the expected value per assertion ID.
4. Append a row to `STATE.md` with `status: pending`.
5. Invoke the leading LLM via `/functional-testing <NN-slug>` (or `all`).

## Why `[RO]` isn't tested in mode `all`

The `[RO]` prefix is added by `registerProxyTool` (`src/server.ts`) and only
applies to proxy descriptions in `namespace` / `single` modes. In `--mode all`,
each tool is registered individually with its original description — there is
no proxy to prefix. Scenarios 01 and 03 cover the prefix already; a 5th
no-prefix-in-all scenario would be empty.

## Cleaning between runs

`reports/<scenario>.*` are committed (they're the comm channel). Between PRs,
clear them with:

```sh
rm tests/functional/reports/*.json tests/functional/reports/*.md
```
