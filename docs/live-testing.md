# Live-testing the MCP server (in a PR / web session)

Two complementary ways to drive a running instance of this server against the
**current branch**, so changes can be exercised before merge.

| | What you get | Needs Zendesk creds? | Needs egress to `*.zendesk.com`? |
|---|---|---|---|
| **A. `.mcp.json`** | Real `mcp__zendesk-local__*` tools, callable live inside a Claude Code session | Yes (for real data) | Yes |
| **B. `scripts/mcp-live.ts`** | One-shot client you run from the terminal | Only for `call` against real data | Only for real `call`s |

Both boot the same `createMcpServer` the production entry point uses
(`src/index.ts`), so what you test is the actual server, not a stub.

## Why `.mcp.json` names every namespace

The committed `.mcp.json` passes `--mode all` **and** lists all four namespaces
explicitly. That is not redundant: `requests` (the end-user surface) is excluded
from the default namespace set, so a bare `--mode all` would expose everything
*except* the end-user tools, and live-testing them would be impossible. Listing
the namespaces makes the rig show the whole surface.

Add a namespace here when you add one to the enum, or it will be invisible to
live testing.

## Auth note (important)

This server is **OAuth 2.1 PKCE only**; there is no API-token mode. The PKCE
flow opens a **browser**, which does not work in a headless remote or web
environment. So for live testing:

- `list` and schema validation work **without any credentials**, no token needed.
- A real `call` needs a Zendesk OAuth **access token**. Sign in once through
  the `zendesk-local` server of `.mcp.json` (call any tool, follow the sign-in
  link): the stdio server persists the token, and the live scripts
  (`mcp-live.ts`, `probe-*.ts`) read it through `scripts/live-auth.ts`, with the
  same silent refresh. Nobody copies the token.
- Where no sign-in can happen (a remote web session), inject
  `ZENDESK_SUBDOMAIN` and `ZENDESK_OAUTH_TOKEN` in the environment
  configuration (not committed); the scripts prefer them when set.

**Agents never handle the token.** No reading the token file, no echoing or
exporting it, no `curl` to Zendesk: the session security classifier blocks
that, and a human has to step in. Use the MCP tools, `pnpm mcp:live`, or a
probe script — each resolves the credential itself.

## A. `.mcp.json`: live tools inside a session

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
  the token comes from the sign-in on first call and is persisted outside the
  repo (see auth note above), never in the file.

MCP servers are connected at **session startup**, not hot-reloaded. So: commit
`.mcp.json` to the branch, then open a **new** Claude Code session on that
branch. The tools appear as `mcp__zendesk-local__*` and can be called live.

## B. `scripts/mcp-live.ts`: one-shot client, no registration

Works immediately in any conversation/terminal, no session restart:

```bash
# List the tools AND resources the server would expose (no creds needed)
pnpm mcp:live list
pnpm mcp:live list -- --mode namespace        # forward server flags after `--`

# Call a tool (needs creds for a real Zendesk response)
pnpm mcp:live call get_current_user '{}'
pnpm mcp:live call get_ticket '{"ticket_id": 123}' -- --mode all

# Read a resource (needs creds — fetched with the caller's token)
pnpm mcp:live read zendesk-hc://topology -- --mode all

# Pick the protocol era (default 2025); the negotiated revision goes to stderr
pnpm mcp:live list --era 2026 -- --mode all
pnpm mcp:live list --era auto -- --mode all

# Drive a running HTTP server instead: signs in through its OAuth flow once
# (prints the URL to open), then reuses the cached tokens
pnpm mcp:live list --url http://localhost:3000/mcp --era 2026
pnpm mcp:live list --url http://localhost:3000/mcp --read-only-scope
pnpm mcp:live probe-unauth --url http://localhost:3000/mcp   # status + WWW-Authenticate
```

Without `--url`, it links a real MCP `Client` to the server over an in-memory
transport, through the same `startStdioTransport` as the binary (identical to
`tests/integration/stdio-harness.ts`), so `tools/list`,
`tools/call`, `resources/list` and `resources/read` cross the wire and dispatch
through the genuine handlers. Use it for quick manual checks, or as a basis for
scripted or CI assertions.

## Probes: raw Zendesk shapes the tools do not show

The tools return formatted text, so a question about what Zendesk really sends
(a sideload honoured or silently dropped, where a value sits in a payload) needs
a probe: a read-only `scripts/probe-<topic>.ts` that hits the live tenant and
prints the raw shape. Conventions:

- GETs only, through `zendeskGet` (the server's retry policy applies).
- Credentials from `live-auth.ts`, never from the caller.
- Print keys, ids, stages, timestamps and numbers, never subjects, bodies or
  names, so the output can go in a PR comment as is.
- A step that fails is a finding: report it and carry on.
- Keep a probe while its question can come back; the history holds the ones
  dropped once answered (`git log --diff-filter=D -- 'scripts/probe-*'`).

```bash
pnpm tsx scripts/probe-sla-alerts-shape.ts [--view <id>] [--ticket <id>]
```

## C. `scripts/validate-retry.mjs`: failure paths, without a flaky network

The retry, timeout and write-safety behaviour of the client only shows itself
when Zendesk misbehaves, which a healthy tenant never does on request. This
runner supplies the misbehaviour:

```bash
pnpm build
node scripts/validate-retry.mjs             # 11 scenarios, ~80 s
node scripts/validate-retry.mjs --skip-slow # drops the two that wait out a deadline
```

Each scenario boots the real server with `scripts/fault-inject.mjs` preloaded —
MSW patching the same global `fetch` the Zendesk client uses — then drives a real
MCP tool call over stdio. It judges the outcome on what the caller received **and
on how many requests Zendesk actually saw**: that count is what proves a write was
not replayed, where a message could be misread. The run exits non-zero if any
scenario fails, so a green result is a fact rather than an impression.

To exercise a mode by hand, set `FAULT` (`none`, `flaky-then-ok`, `500`, `404`,
`429`, `429-brief`, `network`, `stall`, `slow-transfer`) and preload the same file:

```bash
FAULT=500 SUB=validation node --import ./scripts/fault-inject.mjs \
  dist/index.js validation --mode all
```

Two things it cannot do. `HttpResponse.error()` raises a failure with **no syscall
code**, so it cannot tell a pre-send `ENOTFOUND` from an in-flight `ECONNRESET` —
the "never reached Zendesk, retrying is safe" branch is covered by unit tests
only, and a real fault-injecting proxy would be needed to go further. And nothing
here reaches production: `msw` is a devDependency, and no file under `src/`
imports it.
