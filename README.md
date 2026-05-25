# Zendesk MCP Server

[![npm](https://img.shields.io/npm/v/@fruggr/zendesk-mcp-server)](https://www.npmjs.com/package/@fruggr/zendesk-mcp-server)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects LLMs to the **Zendesk Support & Help Center APIs** — with per-user OAuth 2.1 PKCE authentication and fine-grained tool visibility controls. Runs locally over **stdio** or as a private **remote MCP server** over HTTP.

## Why this server?

Most Zendesk integrations use a shared admin API key, giving every user full access to every ticket. This server takes a different approach:

- **Per-user authentication by default** — In both transports, the default is OAuth 2.1 PKCE: each user authenticates with their own Zendesk credentials, so the LLM sees exactly what the user is allowed to see. A static API-token escape hatch is documented below for stdio-only CI / headless contexts; it's refused at boot in HTTP mode.
- **Two deployment shapes, same auth story** — Run it on your laptop as a stdio MCP server (Claude Desktop / Claude Code / VS Code) or deploy it as a private remote MCP server with one user, one Zendesk session per HTTP request.
- **Context-friendly tool modes** — Expose 37 individual tools, 3 namespace proxies, or a single unified tool. Choose the mode that fits your LLM's context budget.
- **Section-based article editing** — For large Help Center articles, read and rewrite one section at a time (parsed by h1/h2/h3 headings) instead of shuffling the full HTML body through the LLM. Reduces tokens by 10–100× on targeted edits.
- **Read-only mode** — Restrict the server to read operations only, ideal for assistants that should never modify data.
- **Lean stack** — Built on `@modelcontextprotocol/sdk`, [`fastmcp`](https://github.com/punkpeye/fastmcp) and `zod`. No Express, no Hono — just the MCP-spec OAuth metadata fastmcp ships out of the box.

> Built and maintained by [Digital4better](https://digital4better.com) for the [Fruggr](https://www.fruggr.io) project.

## Use cases

| Persona | Transport | Auth | Quick start |
|---------|-----------|------|-------------|
| **Run it on your laptop** — single user, plugged into Claude Desktop / Claude Code / VS Code | `stdio` (default) | OAuth 2.1 PKCE in your browser (or API token for CI) | [Quick start: local](#quick-start-local-stdio) |
| **Deploy a private remote MCP server** — one server per Zendesk account, each MCP client carries its own user's OAuth token | `http` | Per-user OAuth 2.1 PKCE bearer in `Authorization:` header; API token refused | [Quick start: remote](#quick-start-remote-http) |

## Tool modes

The server registers tools in one of three modes, controlled by `--mode`:

| Mode | Tools exposed | Best for |
|------|--------------|----------|
| **`all`** | 37 individual tools (`get_ticket`, `search_articles`, ...) | Clients with good tool selection, full granularity |
| **`namespace`** (default) | 3 proxy tools (`zendesk_tickets`, `zendesk_help_center`, `zendesk_users`) | Balanced context usage, grouped operations |
| **`single`** | 1 proxy tool (`zendesk`) | Minimal context footprint, single entry point |

In `namespace` and `single` modes, the proxy tool accepts `{ "operation": "<tool_name>", "params": { ... } }` and dispatches to the appropriate handler after validating params through the original Zod schema. Proxy descriptions include only the first sentence of each sub-operation to stay compact; the full schema is applied when the operation is actually called.

> **Tip:** The `single` mode is particularly useful for models with limited tool slots — one tool handles all 36 operations.

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
<summary><strong>Tickets</strong> (10 tools)</summary>

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
<summary><strong>Help Center</strong> (21 tools)</summary>

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
| `update_article` | Update article metadata (draft, labels, tags, visibility, section) | write |
| `create_article_translation` | Create a translation for an article | write |
| `update_article_translation` | Update an article's translation (full body) | write |
| `update_article_section` | Replace a single section of an article | write |
| `create_content_tag` | Create a new Guide content tag | write |
| `create_article_attachment` | Upload an attachment to an article | write |

</details>

<details>
<summary><strong>Users & Organizations</strong> (5 tools)</summary>

| Tool | Description | Mode |
|------|-------------|------|
| `get_current_user` | Get the authenticated user (verify identity) | read |
| `search_users` | Search users by name, email, or query syntax | read |
| `get_user` | Retrieve a user by ID | read |
| `get_organization` | Retrieve an organization by ID | read |
| `list_organizations` | List all organizations with pagination | read |

</details>

<details>
<summary><strong>Search</strong> (1 tool)</summary>

| Tool | Description | Mode |
|------|-------------|------|
| `search` | Unified search across tickets, users, and organizations | read |

</details>

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

# Or clone and run from source
git clone https://github.com/fruggr/zendesk-mcp-server.git
cd zendesk-mcp-server && pnpm install && pnpm build
node dist/index.js <your-subdomain>
```

### Zendesk OAuth setup

1. Go to **Admin Center → Apps and integrations → APIs → OAuth Clients**
2. Create a **public** client:
   - **Identifier**: `<your-subdomain>_zendesk` (or set `ZENDESK_OAUTH_CLIENT_ID`)
   - **Redirect URL**: `http://localhost:3000/callback`

On the first tool call, a browser window opens for OAuth login. The token is cached in memory for the session.

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

Deploy a private MCP server for **one** Zendesk account. Every MCP client connecting to the server presents its **own** user's OAuth bearer in `Authorization:` — the server never sees a shared admin key.

### Zendesk OAuth setup

1. Go to **Admin Center → Apps and integrations → APIs → OAuth Clients**
2. Create a **public** client:
   - **Client kind**: Public
   - **Identifier**: `<your-subdomain>_zendesk` (or set `ZENDESK_OAUTH_CLIENT_ID`)
   - **Redirect URL**: the callback your MCP client uses (provided by the client itself — for Claude Code on the web this is `https://claude.ai/oauth/callback`, etc.)

### Run the server

```bash
zendesk-mcp-server <your-subdomain> --transport http --port 3000 \
  --public-url https://mcp.example.com
# stderr: Zendesk MCP server running via http on 0.0.0.0:3000
```

`--public-url` (or `PUBLIC_URL=…`) is the URL **clients use to reach you**. It's what gets advertised in the OAuth discovery metadata as the canonical resource identifier (RFC 8707). When the server is behind a TLS reverse proxy — Azure App Service, Heroku, Fly.io, Cloudflare Tunnel, nginx, Caddy… — the bind host and the public URL differ, and spec-compliant MCP clients will refuse the connection if the metadata advertises the wrong resource. Without it the server boots in a degraded mode and prints a warning.

| Platform | Recommended setup |
|---|---|
| **Azure App Service** | Startup command: `PUBLIC_URL="https://$WEBSITE_HOSTNAME" zendesk-mcp-server $ZENDESK_SUBDOMAIN --transport http --port $PORT` |
| **Heroku / Fly / Cloud Run** | `PUBLIC_URL=https://<your-app>.<provider>.app` in the env / config |
| **Caddy / nginx / Traefik in front of a VM** | `PUBLIC_URL=https://mcp.example.com` |
| **Local dev (no proxy)** | `--host 127.0.0.1 --port 3000` — the resource URL is derived automatically (the wildcard `0.0.0.0` is what triggers the warning) |

Verify the OAuth discovery endpoints (served automatically by fastmcp):

```bash
curl -s http://localhost:3000/.well-known/oauth-protected-resource
# → { "authorization_servers": ["https://<subdomain>.zendesk.com"], ... }

curl -s http://localhost:3000/.well-known/oauth-authorization-server
# → { "issuer": "https://<subdomain>.zendesk.com", "authorization_endpoint": "...", ... }

curl -s -i http://localhost:3000/healthz   # → 200 OK
```

### MCP client wiring

```bash
# Claude Code (CLI) — replace localhost with your deployed origin
claude mcp add zendesk --transport http http://localhost:3000/mcp
```

On the first call the MCP client fetches the discovery metadata, performs the OAuth 2.1 PKCE flow against Zendesk on behalf of the **end user**, and sends the resulting access token as a `Bearer` to the server. Each subsequent tool call runs with that user's Zendesk permissions.

### Operator responsibilities

This server provides the MCP transport and the OAuth discovery metadata. The operator is still responsible for:

- **TLS termination** (put the server behind a reverse proxy like Caddy / nginx / Cloudflare Tunnel)
- **Network exposure & firewall** (the server binds `0.0.0.0` by default — choose carefully)
- **Process supervision** (systemd, Docker, fly.io, your hosting provider's runner — none is shipped here)
- **API token credentials are refused at boot in HTTP mode** by design — see [API token authentication](#appendix-api-token-authentication-stdio-only).

## CLI reference

```
zendesk-mcp-server <subdomain> [options]

Options:
  --mode <mode>           single | namespace (default) | all
  --namespace <ns>        Filter by namespace (repeatable): tickets, help_center, users
  --tool <name>           Filter by tool name (repeatable, forces --mode all)
  --read-only             Only expose read operations
  --log-level <level>     debug | info (default) | warn | error
  --transport <t>         stdio (default) | http
  --host <host>           HTTP bind host (default: 0.0.0.0)
  --port <port>           HTTP bind port (default: 3000; 0 = OS-assigned)
  --public-url <url>      Public URL clients use to reach the server (HTTP mode,
                          required behind a TLS reverse proxy)
```

`--namespace` and `--read-only` are applied before the proxies are registered, so they narrow the surface in every mode — in the default `namespace` mode, `--namespace help_center` registers a single proxy (`zendesk_help_center`) instead of three.

**Examples:**

```bash
# Local single-tool mode — minimal context, all 37 operations in one tool
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
| `ZENDESK_EMAIL` | stdio API-token only | — | Agent email for Basic auth — **refused in HTTP** |
| `ZENDESK_API_TOKEN` | stdio API-token only | — | Zendesk API token — **refused in HTTP** |
| `TRANSPORT` | no | `stdio` | `stdio` or `http` |
| `HOST` | no | `0.0.0.0` | HTTP bind host |
| `PORT` | no | `3000` | HTTP bind port (`0` to let the OS pick) |
| `PUBLIC_URL` | recommended in HTTP behind a proxy | derived from host:port | Public URL advertised in OAuth discovery metadata |
| `LOG_LEVEL` | no | `info` | Log verbosity |

In stdio, if both `ZENDESK_EMAIL` and `ZENDESK_API_TOKEN` are set, the server uses API token auth; otherwise it uses OAuth 2.1 PKCE. In HTTP mode, API token credentials are refused at boot — only per-user OAuth 2.1 PKCE is accepted.

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
# Install dependencies
pnpm install

# Dev mode (auto-reload)
ZENDESK_EMAIL=you@example.com ZENDESK_API_TOKEN=xxx \
  pnpm dev -- <your-subdomain> --mode all

# Build
pnpm build

# Type-check
pnpm typecheck

# Lint
pnpm check

# Tests
pnpm test
```

## Appendix: API token authentication (stdio only)

<details>
<summary>Reveal the escape hatch for CI / headless contexts where a browser OAuth flow is impossible.</summary>

A Zendesk API token grants the **issuing user's full rights** to anyone holding it. In HTTP mode this would expose every caller to the same permissions, which is exactly the anti-pattern the per-user OAuth design was built to avoid — the server refuses API-token credentials at boot in HTTP mode.

In stdio mode, however, the credentials never leave the local machine, so an API token is a reasonable escape hatch for CI or headless contexts where no browser is available:

1. **Admin Center → Apps and integrations → APIs → Zendesk API** → enable **Token Access** and create a token.
2. Invoke the binary with the credentials in the environment:

   ```bash
   ZENDESK_EMAIL=you@example.com ZENDESK_API_TOKEN=dneib123... \
     zendesk-mcp-server <your-subdomain> --mode single
   ```

For every other context — laptops, desktops, remote servers — prefer the OAuth flows documented in the local and remote quick-start sections above.

</details>

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
