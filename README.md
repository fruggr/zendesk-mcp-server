# Zendesk MCP Server

[![Glama score](https://glama.ai/mcp/servers/fruggr/zendesk-mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/fruggr/zendesk-mcp-server)
[![npm version](https://img.shields.io/npm/v/@fruggr/zendesk-mcp-server?logo=npm&color=cb3837)](https://www.npmjs.com/package/@fruggr/zendesk-mcp-server)
[![License: MIT](https://img.shields.io/npm/l/@fruggr/zendesk-mcp-server?color=blue)](LICENSE)
[![Node.js](https://img.shields.io/node/v/@fruggr/zendesk-mcp-server?logo=nodedotjs&logoColor=white&color=339933)](https://nodejs.org)
[![Renovate enabled](https://img.shields.io/badge/renovate-enabled-brightgreen?logo=renovatebot&logoColor=white)](https://renovatebot.com)
[![semantic-release](https://img.shields.io/badge/semantic--release-e10079?logo=semantic-release&logoColor=white)](https://github.com/semantic-release/semantic-release)

**Bring Zendesk Support & the Help Center into your AI assistant.** A
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets
your assistant search articles, answer questions, and create, track and update
tickets in plain language — **without switching apps**.

Think of it as the [Zendesk agent for Microsoft 365 Copilot](https://support.zendesk.com/hc/en-us/articles/9958331458458-Using-the-Zendesk-agent-in-Microsoft-365-Copilot),
but **vendor-neutral** — it drops into any MCP client (Claude Desktop, Claude
Code, Cursor, VS Code, …) instead of being tied to one assistant — and it always
acts with **each user's own Zendesk permissions**, never a shared admin key.

## What your assistant can do

Ask in natural language; the assistant figures out context and intent, then calls
the right tools on your behalf:

- **Find answers in the Help Center** — "how do I request a software license?" or
  "what's the time-off policy?" surfaces the right article, by meaning, not just
  keywords.
- **Create, view and update tickets without leaving the conversation** — open a
  ticket, check its status, add a public reply or an internal note, change the
  priority or assignee, or mark it solved.
- **Summarize a ticket for reporting or a quick decision** — pull the details and
  the full comment thread and get the gist in a sentence.
- **Search and triage your queue in plain language** — "show me my open tickets
  about billing from this week."
- **Draft and maintain knowledge-base articles** — write a new article, or revise
  a large one **one section at a time** so the whole HTML body never has to
  round-trip through the model.

Because it runs on the **user's own OAuth session**, the assistant only ever sees
and touches what that person is allowed to — the same scoping you'd get signing
into Zendesk directly.

## How it's different

Most Zendesk integrations use a shared admin API key, giving every user full
access to every ticket, and bolt on a fixed set of tools. This server is built
differently:

- **Per-user authentication, OAuth-only** — In both transports, auth is OAuth 2.1 PKCE: each user authenticates with their own Zendesk credentials, so the assistant sees exactly what the user is allowed to see. Static API tokens are deliberately **not** supported (see [below](#what-this-server-does-not-do)).
- **Two deployment shapes, same auth story** — Run it on your laptop as a stdio MCP server (Claude Desktop / Claude Code / VS Code) or deploy it as a private remote MCP server with one user, one Zendesk session per HTTP request.
- **Context-friendly tool modes** — Expose every operation as its own tool, group them into namespace proxies, or collapse to a single unified tool. Tools are segmented into namespaces you can selectively enable, so each context loads only the surface it needs.
- **Section-based article editing** — For large Help Center articles, read and rewrite one section at a time (parsed by h1/h2/h3 headings) instead of shuffling the full HTML body through the assistant. Reduces tokens by 10–100× on targeted edits.
- **Read-only mode** — Restrict the server to read operations only, ideal for assistants that should never modify data.
- **Lean stack** — Built on the official `@modelcontextprotocol/sdk` plus `zod`.

Under the hood it speaks to the **Zendesk Support & Help Center (Guide) APIs**,
runs locally over **stdio** or as a private **remote MCP server** over HTTP, and
ships fine-grained tool-visibility controls — the specifics are below.

## When to use this server

**Reach for it when:**

- You want an LLM to read or triage **Zendesk tickets** and **Help Center articles** on behalf of a real user, with that user's own permissions — not a shared admin key.
- You're editing **large Help Center articles** and want section-scoped reads/rewrites instead of round-tripping the full HTML body through the model.
- You need to **cap the tool surface** — read-only assistants, a single namespace, or one unified tool to fit a tight context budget.
- You run a **stdio MCP client** (Claude Desktop, Claude Code, Cursor, VS Code, Cline, …) and want a `npx`-installable server with no extra infrastructure, **or** you want to **deploy it as a private remote MCP server** that web/native clients reach over HTTP — each MCP client still carries its own user's OAuth token.

**Look elsewhere when:**

- You need Zendesk products outside Support & Guide (e.g. Talk, Explore analytics, Sell) — those endpoints aren't covered.
- You need a single shared service account, or static API-token auth — this server doesn't support either, by design (see [What this server does *not* do](#what-this-server-does-not-do)).

## What this server does *not* do

**No API-token authentication.** This server is OAuth 2.1 PKCE only — there is no `ZENDESK_EMAIL` + `ZENDESK_API_TOKEN` (Basic auth) mode, in any transport. This is a deliberate design choice:

- **API tokens are insufficiently secure.** A Zendesk API token is a long-lived, static, shared secret that carries the full rights of the issuing user — no per-user scoping, no short expiry, no per-user consent or revocation. OAuth 2.1 PKCE issues per-user, revocable tokens instead, so the LLM only ever sees what the authenticated user is allowed to see.
- **API tokens don't scale.** A single static credential can't attribute actions to individual users or be revoked granularly, and it makes a multi-user remote deployment unsafe (in HTTP it would expose the issuing user's rights to every caller). OAuth scales naturally: each MCP client carries its own user's token.

If you specifically need an API-token / service-account mode (e.g. headless CI with a shared account), use one of the other Zendesk MCP servers that support it — see [Inspiration & related projects](#inspiration--related-projects).

## Use cases

| Persona | Transport | Auth | Quick start |
|---------|-----------|------|-------------|
| **Run it on your laptop** — single user, plugged into Claude Desktop / Claude Code / VS Code | `stdio` (default) | OAuth 2.1 PKCE in your browser | [Quick start: local](#quick-start-local-stdio) |
| **Deploy a private remote MCP server** — one server per Zendesk account, each MCP client carries its own user's OAuth token | `http` | Per-user OAuth 2.1 PKCE bearer in `Authorization:` header | [Quick start: remote](#quick-start-remote-http) |

## Tool modes

The server registers tools in one of three modes, controlled by `--mode`:

| Mode | Tools exposed | Best for |
|------|--------------|----------|
| **`all`** | Every operation as its own tool (`get_ticket`, `search_articles`, ...) | Clients with good tool selection, full granularity |
| **`namespace`** (default) | One proxy tool per namespace (`zendesk_tickets`, `zendesk_help_center`, `zendesk_users`) | Balanced context usage, grouped operations |
| **`single`** | A single proxy tool (`zendesk`) | Minimal context footprint, single entry point |

In `namespace` and `single` modes, the proxy tool accepts `{ "operation": "<tool_name>", "params": { ... } }` and dispatches to the appropriate handler after validating params through the original Zod schema. Proxy descriptions include only the first sentence of each sub-operation to stay compact; the full schema is applied when the operation is actually called.

> **Tip:** The `single` mode is particularly useful for models with limited tool slots — one tool handles every operation.

### Scoping the surface

`--namespace` and `--read-only` apply to every mode (including the default `namespace` mode) — they filter tools **before** the proxies are built, so the description of each proxy reflects only the operations that survive the filters. Combine them to register a focused surface:

```bash
# Only the Help Center proxy, only read-only operations
zendesk-mcp-server acme --namespace help_center --read-only

# Only the Tickets proxy (read + write)
zendesk-mcp-server acme --namespace tickets
```

`--namespace` is repeatable. `--tool` is also available for cherry-picking individual operations but forces `--mode all`.

## Available tools

<details>
<summary><strong>Tickets</strong></summary>

| Tool | Description | Mode |
|------|-------------|------|
| `get_ticket` | Retrieve a ticket by ID with optional comments | read |
| `get_ticket_attachments` | Download ticket attachments (images as base64, others as references) | read |
| `search_tickets` | Search tickets using Zendesk query syntax | read |
| `list_tickets` | List tickets with cursor-based pagination | read |
| `get_linked_incidents` | Get incidents linked to a problem ticket | read |
| `create_ticket` | Create a new ticket with subject, description, priority, tags... | write |
| `update_ticket` | Update ticket status, priority, assignee, tags, custom fields | write |
| `add_private_note` | Add an internal note (not visible to requester) | write |
| `add_public_comment` | Add a public comment (visible to requester) | write |
| `manage_tags` | Add or remove tags on a ticket | write |

</details>

<details>
<summary><strong>Help Center</strong></summary>

| Tool | Description | Mode |
|------|-------------|------|
| `search_articles` | Full-text search across Help Center articles | read |
| `get_article` | Retrieve article by ID with full HTML body | read |
| `get_article_outline` | Compact outline of an article (sections + available translations) | read |
| `get_article_section` | Retrieve a single section (html or markdown) | read |
| `list_categories` | List all Help Center categories | read |
| `list_sections` | List sections, optionally filtered by category | read |
| `list_articles` | List articles with sorting and translation info | read |
| `list_article_translations` | List available translations for an article | read |
| `list_article_attachments` | List attachments on an article | read |
| `list_permission_groups` | List Guide permission groups (needed to create articles) | read |
| `list_content_tags` | List Guide content tags (end-user visible) | read |
| `list_labels` | List article labels (search ranking, not user-visible) | read |
| `list_user_segments` | List user segments (article visibility) | read |
| `compare_translations` | Section-level diff between two locales of an article | read |
| `create_article` | Create a new article in a section | write |
| `update_article` | Update article metadata (draft, labels, tags, visibility, section, sort position) | write |
| `create_article_translation` | Create a translation for an article | write |
| `update_article_translation` | Update an article's translation (full body) | write |
| `update_article_section` | Replace a single section of an article | write |
| `create_content_tag` | Create a new Guide content tag | write |
| `create_article_attachment` | Upload an attachment to an article | write |

</details>

<details>
<summary><strong>Users & Organizations</strong></summary>

| Tool | Description | Mode |
|------|-------------|------|
| `get_current_user` | Get the authenticated user (verify identity) | read |
| `search_users` | Search users by name, email, or query syntax | read |
| `get_user` | Retrieve a user by ID | read |
| `get_organization` | Retrieve an organization by ID | read |
| `list_organizations` | List all organizations with pagination | read |

</details>

<details>
<summary><strong>Search</strong></summary>

| Tool | Description | Mode |
|------|-------------|------|
| `search` | Unified search across tickets, users, and organizations | read |

</details>

## Help Center context (instructions + resources)

Beyond tools, the server hands an LLM the structural context it needs to work
against *your* Help Center — so it stops guessing locales or fuzzy-matching
section names and uses real IDs instead. This is delivered through two
MCP-native channels (both active only when the `help_center` namespace is, and
disabled together with `--no-topology`):

- **`instructions`** (sent on `initialize`): a short, static blob auto-loaded by
  compliant clients. It names the subdomain and points at the topology resource.
- **`zendesk-hc://topology`** (a pull-only [MCP resource](https://modelcontextprotocol.io/docs/concepts/resources)):
  read on demand, it returns Markdown describing the active locales (and the
  default), the category → section tree with IDs, the visibility user segments,
  the permission groups, and the calling user's role. It is fetched **with the
  caller's own token**, so it respects that user's read permissions. On a very
  large Help Center the section tree is summarized (per-category, with a pointer
  to `list_sections`) to stay concise.

Clients that don't consume `instructions` or `resources` simply ignore them —
the feature degrades silently. Use `--no-topology` to turn both off server-wide.

## Prerequisites

- **Node.js** >= 20 (runtime — declared in `package.json#engines.node`)
- A **Zendesk** instance (Support or Suite)

> Contributors and maintainers run the toolchain on a newer Node + pnpm —
> see [Development](#development).

## Quick start: local (stdio)

The default mode. One developer, one Zendesk account, OAuth 2.1 PKCE in the browser.

### Install

```bash
# Run without installing
npx -y @fruggr/zendesk-mcp-server <your-subdomain>

# Or install globally
npm install -g @fruggr/zendesk-mcp-server
zendesk-mcp-server <your-subdomain>
```

> Cloning from source and running a development branch is covered in the [Development](#development) section.

### Zendesk OAuth setup

1. Go to **Admin Center → Apps and integrations → APIs → OAuth Clients**
2. Create a **public** client:
   - **Identifier**: `<your-subdomain>_zendesk` (or set `ZENDESK_OAUTH_CLIENT_ID`)
   - **Redirect URL**: `http://localhost:27439/callback` (change the port to match
     `ZENDESK_OAUTH_CALLBACK_PORT` / `--callback-port` if you override it; Zendesk
     accepts several redirect URLs, one per line)

### Run

```bash
zendesk-mcp-server <your-subdomain>
```

On the first tool call, the server starts the sign-in flow: it opens a browser
window **and** returns a tool message containing the authorize URL. The call
does not block waiting for sign-in — authenticate in the browser (or open the
URL manually if it didn't open), then retry the request.

Once authenticated, the token is **persisted to disk** (one owner-only `0600`
file per subdomain in your OS config dir —
`%APPDATA%\fruggr\zendesk-mcp-server\<subdomain>.json` on Windows,
`${XDG_CONFIG_HOME:-~/.config}/fruggr/zendesk-mcp-server/<subdomain>.json`
elsewhere; override the path with `ZENDESK_TOKEN_FILE`). It is reused across restarts, so you don't
re-authenticate every time the MCP client respawns the server. If the Zendesk
OAuth client has token expiration enabled, the stored refresh token is used to
renew access silently — **proactively** (the token is refreshed before use when
it's expired, near expiry, or of unknown age, so the first request after an
overnight gap never hits a visible auth error) and **periodically** in the
background so a long-lived, idle session never serves a stale token. Only an
expired/invalid refresh token triggers a new browser sign-in.

> **Port conflict?** If port `27439` is already in use the first tool call returns
> a clear error telling you to set `ZENDESK_OAUTH_CALLBACK_PORT` (or
> `--callback-port`) to a free port — remember to register the matching
> `http://localhost:<port>/callback` redirect URL in your Zendesk OAuth client.

### MCP client wiring

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zendesk": {
      "command": "npx",
      "args": ["-y", "@fruggr/zendesk-mcp-server", "<your-subdomain>", "--mode", "single"]
    }
  }
}
```

</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add zendesk -- npx -y @fruggr/zendesk-mcp-server <your-subdomain> --mode single
```

</details>

<details>
<summary><strong>VS Code (Copilot / Continue / Cline)</strong></summary>

Add to your `.vscode/mcp.json`:

```json
{
  "servers": {
    "zendesk": {
      "command": "npx",
      "args": ["-y", "@fruggr/zendesk-mcp-server", "<your-subdomain>", "--mode", "single"]
    }
  }
}
```

</details>

## Quick start: remote (HTTP)

> 🧪 **Experimental.** The HTTP transport is shipped but has not yet been
> exercised end-to-end against a real Zendesk tenant from every supported
> MCP client. Local stdio is the supported path. Until this notice is
> removed, expect rough edges around OAuth discovery behind reverse
> proxies, CORS with browser clients, and 401 / refresh flows — please
> open an issue with the symptoms you hit.

Deploy a private MCP server for **one** Zendesk account. Every MCP client connecting to the server presents its **own** user's OAuth bearer in `Authorization:` — the server never sees a shared admin key.

### Zendesk OAuth setup

Same procedure as the [local quick start](#zendesk-oauth-setup), with one difference: the **Redirect URL** must match the callback your MCP client uses — provided by the client itself, e.g. `https://claude.ai/oauth/callback` for claude.ai on the web. Check your client's docs.

### Run the server

```bash
zendesk-mcp-server <your-subdomain> --transport http --port 3000 \
  --public-url https://mcp.example.com
# stderr: Zendesk MCP server running via http on 0.0.0.0:3000
```

### Public URL

`--public-url` (or `PUBLIC_URL=…`) is the URL **clients use to reach you**. It's what gets advertised in the OAuth discovery metadata as the canonical resource identifier (RFC 8707). When the server is behind a TLS reverse proxy — Azure App Service, Heroku, Fly.io, Cloudflare Tunnel, nginx, Caddy… — the bind host and the public URL differ, and spec-compliant MCP clients will refuse the connection if the metadata advertises the wrong resource. Without it the server boots in a degraded mode and prints a warning.

| Platform | Recommended setup |
|---|---|
| **Azure App Service** | Startup command: `PUBLIC_URL="https://$WEBSITE_HOSTNAME" zendesk-mcp-server $ZENDESK_SUBDOMAIN --transport http --port $PORT` |
| **Heroku / Fly / Cloud Run** | `PUBLIC_URL=https://<your-app>.<provider>.app` in the env / config |
| **Caddy / nginx / Traefik in front of a VM** | `PUBLIC_URL=https://mcp.example.com` |
| **Local dev (no proxy)** | `--host 127.0.0.1 --port 3000` — the resource URL is derived automatically (the wildcard `0.0.0.0` is what triggers the warning) |

### Authentication on every request

`Authorization: Bearer …` is required on **every** `/mcp` request — a session id alone is never accepted as a credential. The most recent bearer presented on a session is the one used for Zendesk calls, so a client refreshing its token mid-session just works.

### Verify discovery endpoints

Served by the HTTP transport in `src/transports/http.ts`:

```bash
curl -s http://localhost:3000/.well-known/oauth-protected-resource
# → { "authorization_servers": ["https://<subdomain>.zendesk.com"], ... }

curl -s http://localhost:3000/.well-known/oauth-authorization-server
# → { "issuer": "https://<subdomain>.zendesk.com", "authorization_endpoint": "...", ... }

curl -s -i http://localhost:3000/healthz   # → 200 OK
```

### MCP client wiring

Every major MCP client supports remote servers over Streamable HTTP and handles the OAuth 2.1 PKCE discovery flow natively — paste the URL, sign in once, you're connected. Replace `https://mcp.example.com` below with your deployed origin.

<details>
<summary><strong>Claude Code (CLI)</strong></summary>

```bash
claude mcp add zendesk --transport http https://mcp.example.com/mcp
```

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

**Settings → Connectors → + Add custom connector**, paste `https://mcp.example.com/mcp`, click **Connect**. Claude Desktop drives the OAuth flow in your browser on first call.

</details>

<details>
<summary><strong>claude.ai (web)</strong></summary>

**Settings → Connectors → Add custom connector**, same URL. The OAuth flow runs in the same tab.

</details>

<details>
<summary><strong>VS Code (GitHub Copilot / Continue / Cline)</strong></summary>

Add to your `.vscode/mcp.json`:

```json
{
  "servers": {
    "zendesk": {
      "type": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor, Windsurf</strong></summary>

Both expose an MCP settings UI that accepts a remote URL. Paste `https://mcp.example.com/mcp` and sign in when prompted.

</details>

<details>
<summary><strong>Zed</strong></summary>

Zed added native OAuth 2.0 + PKCE for Streamable HTTP MCP servers in 2026 ([zed-industries/zed#51768](https://github.com/zed-industries/zed/pull/51768)). Configure the remote server in your Zed settings; on first use Zed opens a loopback browser callback to complete the flow.

If you're on an older Zed build that predates that change, fall back to [`mcp-remote`](https://github.com/geelen/mcp-remote) as a local shim that does the OAuth flow on your machine and proxies the session:

```json
{
  "context_servers": {
    "zendesk": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.example.com/mcp"]
    }
  }
}
```

</details>

On the first call the MCP client fetches the discovery metadata, performs the OAuth 2.1 PKCE flow against Zendesk on behalf of the **end user**, and sends the resulting access token as a `Bearer` to the server. Each subsequent tool call runs with that user's Zendesk permissions.

### CORS

The HTTP transport ships a default CORS allowlist that covers today's major **browser-based** MCP clients out of the box (ordered by user base): `chatgpt.com`, `claude.ai`, `gemini.google.com`, `copilot.microsoft.com`, `perplexity.ai`, `chat.mistral.ai`, `grok.com`, plus `chat.openai.com`. Localhost on any port (MCP Inspector, dev pages) is also always allowed.

**Native MCP clients** (Claude Desktop / Claude Code CLI / Cursor / VS Code / Zed) send no `Origin` header — CORS doesn't apply to them, they work regardless.

To allow an additional browser origin (custom dashboard, internal portal), pass `--cors-origin` (repeatable) or set `CORS_ORIGIN` as a comma-separated list:

```bash
zendesk-mcp-server acme --transport http --port 3000 \
  --cors-origin https://internal-dashboard.example.com \
  --cors-origin https://team-portal.example.com
```

The defaults are always applied — your additions extend them, they don't replace them.

### Operator responsibilities

This server provides the MCP transport and the OAuth discovery metadata. The operator is still responsible for:

- **TLS termination** (put the server behind a reverse proxy like Caddy / nginx / Cloudflare Tunnel)
- **Network exposure & firewall** (the server binds `0.0.0.0` by default — choose carefully)
- **Process supervision** (systemd, Docker, fly.io, your hosting provider's runner — none is shipped here)

## CLI reference

```
zendesk-mcp-server <subdomain> [options]

Options:
  --mode <mode>           single | namespace (default) | all
  --namespace <ns>        Filter by namespace (repeatable): tickets, help_center, users
  --tool <name>           Filter by tool name (repeatable, forces --mode all)
  --read-only             Only expose read operations
  --no-topology           Disable the Help Center structural context
                          (instructions + zendesk-hc://topology resource)
  --log-level <level>     debug | info (default) | warn | error
  --transport <t>         stdio (default) | http
  --host <host>           HTTP bind host (default: 0.0.0.0)
  --port <port>           HTTP bind port (default: 3000; 0 = OS-assigned)
  --public-url <url>      Public URL clients use to reach the server (HTTP mode,
                          required behind a TLS reverse proxy)
  --cors-origin <url>     Extra browser origin allowed by CORS (repeatable;
                          adds to the default allowlist of major web MCP
                          clients + localhost-any-port)
  --callback-port <port>  Local OAuth callback port for stdio (default 27439)
```

`--namespace` and `--read-only` are applied before the proxies are registered, so they narrow the surface in every mode — in the default `namespace` mode, `--namespace help_center` registers a single proxy (`zendesk_help_center`) instead of three.

**Examples:**

```bash
# Local single-tool mode — minimal context, every operation in one tool
zendesk-mcp-server acme --mode single

# Read-only tickets only
zendesk-mcp-server acme --read-only --namespace tickets

# Cherry-pick specific tools
zendesk-mcp-server acme --tool get_ticket --tool search_tickets --tool get_current_user

# Remote HTTP, read-only Help Center surface
zendesk-mcp-server acme --transport http --port 8080 \
  --namespace help_center --read-only
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ZENDESK_SUBDOMAIN` | yes (or CLI arg) | — | Zendesk subdomain (e.g., `acme` for acme.zendesk.com) |
| `ZENDESK_OAUTH_CLIENT_ID` | no | `<subdomain>_zendesk` | OAuth client identifier |
| `ZENDESK_OAUTH_CALLBACK_PORT` | no | `27439` | Local port for the OAuth browser callback (also `--callback-port`). Must match the redirect URL registered in Zendesk. **stdio only**. |
| `ZENDESK_TOKEN_FILE` | no | OS config dir | Path to the persisted OAuth token file (`0600`). |
| `TRANSPORT` | no | `stdio` | `stdio` or `http` |
| `HOST` | no | `0.0.0.0` | HTTP bind host |
| `PORT` | no | `3000` | HTTP bind port (`0` to let the OS pick) |
| `PUBLIC_URL` | recommended in HTTP behind a proxy | derived from host:port | Public URL advertised in OAuth discovery metadata |
| `CORS_ORIGIN` | no | — | Comma-separated browser origins added to the default CORS allowlist |
| `LOG_LEVEL` | no | `info` | Log verbosity (`debug` surfaces the full OAuth flow trace) |

The server uses per-user OAuth 2.1 PKCE for every transport (local stdio and remote HTTP). There is no static API-token mode — see [What this server does *not* do](#what-this-server-does-not-do).

## Troubleshooting

### The browser doesn't open during OAuth login

The OAuth flow opens your default browser on the first tool call. The first call
fails fast with a message that includes the authorize URL, so even if the
browser can't open (common in sandboxed or remote desktop environments) you can
open that URL manually — it's also printed to the server's stderr. Sign in, then
retry the request.

To collect diagnostics, restart with `LOG_LEVEL=debug`. The server then emits
structured logs through **two channels**, so they're reachable on any MCP client:

- **stderr** — captured to a log file by every mainstream client.
- **MCP logging notifications** (`notifications/message`) — surfaced by clients
  that support the `logging` capability.

When the browser fails to open, look for the `oauth_browser_open_failed` event:
it reports the underlying error, the platform, and which environment markers are
present (no secrets, tokens, or env values are ever logged).

### The OAuth callback port is already in use

The sign-in flow runs a short-lived local server on port `27439` to receive the
callback. If that port is taken, the first tool call fails with a message saying
so (and logs `oauth_callback_listen_failed`). Pick a free port with
`ZENDESK_OAUTH_CALLBACK_PORT=<port>` (or `--callback-port <port>`), and register
the matching `http://localhost:<port>/callback` redirect URL in your Zendesk
OAuth client.

### I have to re-authenticate every time

The OAuth token is persisted to an owner-only file in your OS config dir and
reused across restarts, so this shouldn't happen. If it does, check that the file
is writable (`ZENDESK_TOKEN_FILE` to relocate it) and look for
`token_persist_failed` in the logs.

Where each client writes the server's stderr:

| Client | Log location |
|--------|--------------|
| Claude Desktop (macOS) | `~/Library/Logs/Claude/mcp-server-*.log` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\logs\mcp-server-*.log` |
| Claude Code | `claude --debug`, or the session logs |
| Cursor / VS Code / Cline | the extension's MCP output/log panel |

## Development

### Toolchain

| Tool | Version | Source of truth |
| ---- | ------- | ---------------- |
| Node | 24 | [`.nvmrc`](.nvmrc) — read by `nvm`, `fnm`, `mise`, `asdf`, `volta` |
| pnpm | 11 | [`package.json#packageManager`](package.json) (pinned with a corepack integrity hash) |

The toolchain (Node 24 + pnpm 11) is used to build, lint, type-check and
test the project. The **published package** still runs on Node 20+ (see
`engines.node`); a dedicated CI job installs the packed tarball on Node 20
and runs the smoke test to keep that promise honest.

```bash
# Clone, install, build
git clone https://github.com/fruggr/zendesk-mcp-server.git
cd zendesk-mcp-server && pnpm install && pnpm build
node dist/index.js <your-subdomain>

# Dev mode, OAuth (browser opens on first tool call)
pnpm dev -- <your-subdomain> --mode all

# Dev mode, HTTP transport (OAuth bearer from the MCP client)
pnpm dev -- <your-subdomain> --transport http --port 3000 --public-url http://localhost:3000

# Build / typecheck / lint / test
pnpm build && pnpm typecheck && pnpm check && pnpm test
```

To test a PR branch without publishing to npm — the `prepare` script builds on install:

```bash
npx -y github:fruggr/zendesk-mcp-server <your-subdomain>
npx -y github:fruggr/zendesk-mcp-server#my-feature-branch <your-subdomain>
```

Contributor conventions (architecture, code style, submission bar, release workflow) live in [`AGENTS.md`](AGENTS.md).

## Inspiration & related projects

This project was built with reference to:
- The official [Zendesk API documentation](https://developer.zendesk.com/api-reference/)
- [mattcoatsworth/zendesk-mcp-server](https://github.com/mattcoatsworth/zendesk-mcp-server)
- [koundinya/zd-mcp-server](https://github.com/koundinya/zd-mcp-server)

## Releases & versioning

Versions follow [SemVer](https://semver.org/) and are calculated **automatically** from commit messages — no one bumps the version by hand. Every merge to `main` triggers [semantic-release](https://github.com/semantic-release/semantic-release), which inspects the new [Conventional Commits](https://www.conventionalcommits.org/) since the previous tag, computes the next version, updates [`CHANGELOG.md`](CHANGELOG.md), publishes to npm, and creates the matching GitHub Release.

| Commit type | Resulting bump |
|---|---|
| `fix:`, `perf:` | patch |
| `feat:` | minor |
| `feat!:`, `fix!:`, or a `BREAKING CHANGE:` footer | major |
| `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `style:`, `build:` | no release |

## FAQ

**Do I need a Zendesk admin API key?**
No — and the server doesn't support one. The OAuth 2.1 PKCE flow means each user
authenticates with their own credentials and the server acts with exactly their
permissions. Static API tokens are intentionally unsupported (see
[What this server does *not* do](#what-this-server-does-not-do)).

**Which Zendesk products are supported?**
Zendesk Support (tickets, users, organizations) and the Help Center / Guide
(articles, sections, categories, translations, labels, content tags, segments,
attachments). Talk, Explore, and Sell are out of scope.

**How do I keep the model's context small?**
Use `--mode single` (one `zendesk` tool) or `--mode namespace` (three proxies),
and `--read-only` to drop write operations. For big articles, the section-based
tools (`get_article_outline`, `get_article_section`, `update_article_section`)
let the model touch one section at a time instead of the whole HTML body.

**Can I restrict it to read-only?**
Yes — pass `--read-only` and every write tool is filtered out before the proxies
are built, in any mode.

**Which Node.js version do I need?**
Node.js >= 20 to run the published package (`engines.node`). The dev toolchain
uses a newer Node — see [Development](#development).

**The OAuth browser window didn't open. What now?**
The authorization URL is also printed to stderr — open it manually. Restart with
`LOG_LEVEL=debug` for the full flow trace. See
[Troubleshooting](#troubleshooting).

**Is it safe to run via `npx`?**
Releases are published from CI via npm Trusted Publishing (OIDC), so each version
carries a build provenance attestation you can verify on its
[npm page](https://www.npmjs.com/package/@fruggr/zendesk-mcp-server). No secrets
are ever logged by the server.

## Contributing

Pull requests are welcome — including AI-assisted ones, as long as the human author has read and validated every line.

The full guide is in [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version:

1. Fork and create a feature branch from `main`.
2. Practice TDD: write the failing test first, then implement.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) — they drive the next version bump via semantic-release.
4. Make `pnpm check`, `pnpm typecheck`, and `pnpm test` pass locally.
5. Run a Claude Code review on your diff before pushing.
6. Open a PR.

Every PR is reviewed automatically by [CodeRabbit](https://www.coderabbit.ai) in CI, on top of the author-side AI review. The project is maintained in part with [Claude Code](https://www.anthropic.com/claude-code) assistance; that workflow is documented in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[MIT](LICENSE)

---

> Built and maintained by [Digital4better](https://digital4better.com) for the [Fruggr](https://www.fruggr.io) project.
