# Live-testing the MCP server (in a PR / web session)

Two complementary ways to drive a running instance of this server against the
**current branch**, so changes can be exercised before merge.

| | What you get | Needs Zendesk creds? | Needs egress to `*.zendesk.com`? |
|---|---|---|---|
| **A. `.mcp.json`** | Real `mcp__zendesk-local__*` tools, callable live inside a Claude Code session | Yes (for real data) | Yes |
| **B. `scripts/mcp-live.ts`** | One-shot client you run from the terminal | Only for `call` against real data | Only for real `call`s |

Both boot the same `createMcpServer` the production entry point uses
(`src/index.ts`), so what you test is the actual server, not a stub.

## Auth note (important)

This server is **OAuth 2.1 PKCE only** — there is no API-token mode. The PKCE
flow opens a **browser**, which does not work in a headless remote/web
environment. So for live testing:

- `list` and schema validation work **without any credentials** — no token needed.
- A real `call` needs a Zendesk OAuth **access token**. Obtain one via the normal
  OAuth flow (e.g. in a local session where the browser can open), then provide it:

  ```
  ZENDESK_SUBDOMAIN=<your-subdomain>
  ZENDESK_OAUTH_TOKEN=<oauth-access-token>
  ```

In a Claude Code web environment, inject these as environment variables in the
environment configuration (not committed).

## A. `.mcp.json` — live tools inside a session

A project-scoped `.mcp.json` is committed at the repo root:

```json
{
  "mcpServers": {
    "zendesk-local": {
      "command": "pnpm",
      "args": ["exec", "tsx", "src/index.ts", "--mode", "all"],
      "env": {
        "ZENDESK_SUBDOMAIN": "fruggr"
      }
    }
  }
}
```

- Runs the server straight from **source** via `tsx`, so it always reflects the
  checked-out branch (no build step). Requires `pnpm install` to have run.
- `--mode all` exposes every individual tool so you can call any operation
  directly. Drop it for the default `namespace` mode, or pass
  `--read-only` / `--namespace <ns>` to scope the surface.
- `ZENDESK_SUBDOMAIN` is set in the file (`fruggr`) since it is not a secret;
  the OAuth access token (`ZENDESK_OAUTH_TOKEN`) still comes from the environment
  (see auth note above) and is never stored in the file.

MCP servers are connected at **session startup**, not hot-reloaded. So: commit
`.mcp.json` to the branch, then open a **new** Claude Code session on that
branch. The tools appear as `mcp__zendesk-local__*` and can be called live.

## B. `scripts/mcp-live.ts` — one-shot client, no registration

Works immediately in any conversation/terminal, no session restart:

```bash
# List the tools the server would expose (no creds needed)
pnpm mcp:live list
pnpm mcp:live list -- --mode namespace        # forward server flags after `--`

# Call a tool (needs creds for a real Zendesk response)
pnpm mcp:live call get_current_user '{}'
pnpm mcp:live call get_ticket '{"ticket_id": 123}' -- --mode all
```

It links a real MCP `Client` to the server over an in-memory transport
(identical to `tests/integration/stdio-harness.ts`), so `tools/list` and
`tools/call` cross the wire and dispatch through the genuine handlers. Use it
for quick manual checks or as a basis for scripted/CI assertions.
