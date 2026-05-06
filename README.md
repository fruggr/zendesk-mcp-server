# Zendesk MCP Server

[![npm](https://img.shields.io/npm/v/@fruggr/zendesk-mcp-server)](https://www.npmjs.com/package/@fruggr/zendesk-mcp-server)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects LLMs to the **Zendesk Support & Help Center APIs** — with per-user OAuth 2.1 PKCE authentication and fine-grained tool visibility controls.

## Why this server?

Most Zendesk integrations use a shared admin API key, giving every user full access to every ticket. This server takes a different approach:

- **Per-user authentication** — Each user authenticates with their own Zendesk credentials via OAuth 2.1 PKCE. No shared admin key, no elevated privileges. The LLM sees exactly what the user is allowed to see.
- **Context-friendly tool modes** — Expose 37 individual tools, 3 namespace proxies, or a single unified tool. Choose the mode that fits your LLM's context budget.
- **Section-based article editing** — For large Help Center articles, read and rewrite one section at a time (parsed by h1/h2/h3 headings) instead of shuffling the full HTML body through the LLM. Reduces tokens by 10–100× on targeted edits.
- **Read-only mode** — Restrict the server to read operations only, ideal for assistants that should never modify data.
- **Zero runtime dependencies beyond the MCP SDK** — Built on `@modelcontextprotocol/sdk` and `zod`. No Express, no heavyweight frameworks.

> Built and maintained by [Digital4better](https://digital4better.com) for the [Fruggr](https://www.fruggr.io) project.

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

- **Node.js** >= 20
- A **Zendesk** instance (Support or Suite)

## Installation

```bash
# Run without installing
npx -y @fruggr/zendesk-mcp-server <your-subdomain>
```

Or install globally:

```bash
npm install -g @fruggr/zendesk-mcp-server
zendesk-mcp-server <your-subdomain>
```

Or clone and run locally:

```bash
git clone https://github.com/fruggr/zendesk-mcp-server.git
cd zendesk-mcp-server
pnpm install
pnpm build
node dist/index.js <your-subdomain>
```

## Authentication

The server supports two authentication methods:

### Option A: OAuth 2.1 PKCE (recommended)

No API key needed. Each user authenticates via their browser on the first tool call.

**Zendesk setup:**

1. Go to **Admin Center > Apps and integrations > APIs > OAuth Clients**
2. Create a public client:
   - **Identifier**: `<your-subdomain>_zendesk` (or set `ZENDESK_OAUTH_CLIENT_ID`)
   - **Redirect URL**: `http://localhost:3000/callback`

**Run:**

```bash
zendesk-mcp-server <your-subdomain>
```

On the first tool call, a browser window opens for the user to authenticate. The token is cached in memory for the session.

### Option B: API token

For headless/CI environments or quick testing.

**Zendesk setup:**

1. Go to **Admin Center > Apps and integrations > APIs > Zendesk API**
2. Enable **Token Access**, create a token

**Run:**

```bash
ZENDESK_EMAIL=you@example.com ZENDESK_API_TOKEN=dneib123... \
  zendesk-mcp-server <your-subdomain>
```

## Configuration

### MCP client configuration

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zendesk": {
      "command": "npx",
      "args": ["-y", "@fruggr/zendesk-mcp-server", "<your-subdomain>", "--mode", "single"],
      "env": {
        "ZENDESK_EMAIL": "you@example.com",
        "ZENDESK_API_TOKEN": "your-api-token"
      }
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

For API token auth, set the env vars before launching Claude Code or add them to your shell profile.

</details>

<details>
<summary><strong>VS Code (Copilot / Continue / Cline)</strong></summary>

Add to your `.vscode/mcp.json`:

```json
{
  "servers": {
    "zendesk": {
      "command": "npx",
      "args": ["-y", "@fruggr/zendesk-mcp-server", "<your-subdomain>", "--mode", "single"],
      "env": {
        "ZENDESK_EMAIL": "you@example.com",
        "ZENDESK_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

</details>

### CLI reference

```
zendesk-mcp-server <subdomain> [options]

Options:
  --mode <mode>           single | namespace (default) | all
  --namespace <ns>        Filter by namespace (repeatable): tickets, help_center, users
  --tool <name>           Filter by tool name (repeatable, forces --mode all)
  --read-only             Only expose read operations
  --log-level <level>     debug | info (default) | warn | error
```

`--namespace` and `--read-only` are applied before the proxies are registered, so they narrow the surface in every mode — in the default `namespace` mode, `--namespace help_center` registers a single proxy (`zendesk_help_center`) instead of three.

**Examples:**

```bash
# Single tool mode — minimal context, all 37 operations in one tool
zendesk-mcp-server acme --mode single

# Read-only tickets only
zendesk-mcp-server acme --read-only --namespace tickets

# Cherry-pick specific tools
zendesk-mcp-server acme --tool get_ticket --tool search_tickets --tool get_current_user
```

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ZENDESK_SUBDOMAIN` | yes (or CLI arg) | — | Zendesk subdomain (e.g., `acme` for acme.zendesk.com) |
| `ZENDESK_OAUTH_CLIENT_ID` | no | `<subdomain>_zendesk` | OAuth client identifier |
| `ZENDESK_EMAIL` | for API token auth | — | Agent email for Basic auth |
| `ZENDESK_API_TOKEN` | for API token auth | — | Zendesk API token |
| `LOG_LEVEL` | no | `info` | Log verbosity |

If both `ZENDESK_EMAIL` and `ZENDESK_API_TOKEN` are set, the server uses API token auth. Otherwise, it uses OAuth 2.1 PKCE.

## Development

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
