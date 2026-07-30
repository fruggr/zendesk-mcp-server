# Zendesk MCP Server

[![Glama score](https://glama.ai/mcp/servers/fruggr/zendesk-mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/fruggr/zendesk-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.fruggr%2Fzendesk--mcp--server-0a7ea4)](https://registry.modelcontextprotocol.io/?search=io.github.fruggr/zendesk-mcp-server)
[![npm version](https://img.shields.io/npm/v/@fruggr/zendesk-mcp-server?logo=npm&color=cb3837)](https://www.npmjs.com/package/@fruggr/zendesk-mcp-server)
[![License: MIT](https://img.shields.io/npm/l/@fruggr/zendesk-mcp-server?color=blue)](LICENSE)
[![Node.js](https://img.shields.io/node/v/@fruggr/zendesk-mcp-server?logo=nodedotjs&logoColor=white&color=339933)](https://nodejs.org)
[![Renovate enabled](https://img.shields.io/badge/renovate-enabled-brightgreen?logo=renovatebot&logoColor=white)](https://renovatebot.com)
[![semantic-release](https://img.shields.io/badge/semantic--release-e10079?logo=semantic-release&logoColor=white)](https://github.com/semantic-release/semantic-release)

**Bring Zendesk deep into your AI assistant.** A
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server: find
answers in the Help Center, **draft, update and translate** articles (keeping
languages in sync), and **manage Support tickets** end to end — comments, triage
and image attachments — all in plain language,
**without switching apps**.

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
- **Read the screenshots and photos attached to a ticket** — error dialogs, UI
  captures or product photos are handed to your assistant's own model as images,
  so it can describe them or act on what they show.
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
- **Native multimodal attachments** — ticket images are delivered as native MCP image content for the **client's own model** to analyze: no server-side vision model, **no extra API key**, fully vendor-neutral (see [Attachments & vision](#attachments--vision)).
- **Read-only mode** — Restrict the server to read operations only, ideal for assistants that should never modify data.
- **Lean stack** — Built on the official `@modelcontextprotocol/sdk` plus `zod`.

Under the hood it speaks to the **Zendesk Support & Help Center (Guide) APIs**,
runs locally over **stdio** or as a private **remote MCP server** over HTTP, and
ships fine-grained tool-visibility controls — the specifics are below.

### Attachments & vision

Ticket image attachments are returned as **native MCP multimodal content**, so the
assistant's own model (Claude, GPT, Gemini, …) sees the pixels directly. There is
no server-side vision model and **no extra API key** — the opposite of servers
that expose an `analyze_ticket_images`-style tool calling a vision model with the
operator's own key.

| | This server | Server-side-analysis alternatives |
|---|---|---|
| Who sees the image | The **client's own model** receives the pixels as multimodal input | The **server** calls a vision model with **its own API key** |
| Extra dependencies | None | Vision-model API key + billing on the server |
| Vendor neutrality | ✅ Full | ❌ Locked to one provider |

Non-image attachments come back as text references. The per-image size cap and the
number of embedded images are **configurable** — see
[`ZENDESK_MAX_ATTACHMENT_BYTES`](docs/configuration.md#zendesk_max_attachment_bytes)
and [`ZENDESK_MAX_EMBEDDED_IMAGES`](docs/configuration.md#zendesk_max_embedded_images).

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

The tools are grouped into four namespaces — **Tickets**, **Help Center**,
**Users & Organizations**, and **Search** — each of which you can enable
selectively with `--namespace` (see [Tool modes](#tool-modes)).

The full tool-by-tool reference — every tool with its description and its
`read`/`write` mode — lives in
**[docs/mcp-tools-reference.md](docs/mcp-tools-reference.md)**.

## Help Center context (instructions + resources)

Beyond tools, the server hands an LLM the structural context it needs to work
against *your* Help Center — so it stops guessing locales or fuzzy-matching
section names and uses real IDs instead. This is delivered through MCP-native
channels (all active only when the `help_center` namespace is), each fetched
**with the caller's own token** so it respects that user's read permissions:

- **`instructions`** (sent on `initialize`): a short, static blob auto-loaded by
  compliant clients. It names the subdomain and points at the topology resource.
- **`zendesk-hc://topology`** (a pull-only [MCP resource](https://modelcontextprotocol.io/docs/concepts/resources)):
  read on demand, it returns Markdown describing the active locales (and the
  default), the category → section tree with IDs, the visibility user segments,
  the permission groups, and the calling user's role. Listing the permission
  groups and user segments needs Guide-admin / Help Center manager rights; with a
  content-editor token those two sections are marked *unavailable* (not empty) and
  the rest still renders — reuse those IDs from an existing article (`get_article`)
  instead. On a very large Help Center the section tree is summarized (per-category,
  with a pointer to `list_sections`) to stay concise.
- **`zendesk-hc://article/{id}`** (pull-only [MCP resources](https://modelcontextprotocol.io/docs/concepts/resources)):
  the listing surfaces the promoted (*featured*) articles so a user can pin one as
  first-class context in clients that support resource pinning / @-mention; any
  article id can then be read on demand, returned as Markdown. Clients that don't
  support resources ignore these silently.

The `instructions` blob and the topology resource are toggled together with
`--no-topology`; the article resources are toggled independently with
`--no-article-resources`. Clients that don't consume `instructions` or
`resources` simply ignore them — the feature degrades silently. The `zendesk-hc://`
URI scheme is the default; a deployer can brand it with
[`--hc-resource-scheme` / `HC_RESOURCE_SCHEME`](docs/configuration.md#hc_resource_scheme)
(e.g. `wiki` → `wiki://topology`, `wiki://article/{id}`).

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

> 🧪 **Experimental.** The HTTP transport is shipped but not yet exercised
> end-to-end against a real Zendesk tenant from every MCP client — local stdio is
> the supported path.

You can also deploy a private remote MCP server for **one** Zendesk account, where
every MCP client presents its **own** user's OAuth bearer in `Authorization:` (the
server never sees a shared admin key). The full guide — OAuth setup, `--public-url`
behind a reverse proxy, per-platform config, discovery endpoints, MCP client
wiring, CORS and operator responsibilities — is in
**[docs/http-deployment.md](docs/http-deployment.md)**.

## Configuration

The complete reference for the CLI flags (`--mode`, `--namespace`, `--read-only`,
`--transport`, `--public-url`, …) and the environment variables (`ZENDESK_SUBDOMAIN`,
`ZENDESK_TOKEN_FILE`, `PUBLIC_URL`, the attachment-vision caps, …) lives in
**[docs/configuration.md](docs/configuration.md)** — with a per-variable anchor so
you can deep-link a specific setting.

The server uses per-user OAuth 2.1 PKCE for every transport (local stdio and remote HTTP). There is no static API-token mode — see [What this server does *not* do](#what-this-server-does-not-do).

## Troubleshooting

Browser not opening during OAuth login, the callback port already in use, having
to re-authenticate every time, and where each client writes the server's stderr
are covered in **[docs/troubleshooting.md](docs/troubleshooting.md)**. Restart
with `LOG_LEVEL=debug` for the full OAuth flow trace.

## Development

Setting up the repo, the toolchain (Node 24 + pnpm 11), dev mode and how to test
a PR branch are covered in **[CONTRIBUTING.md](CONTRIBUTING.md#development-setup)**.
Architecture and code-style conventions live in [`AGENTS.md`](AGENTS.md).

## Inspiration & related projects

This project was built with reference to:
- The official [Zendesk API documentation](https://developer.zendesk.com/api-reference/)
- [mattcoatsworth/zendesk-mcp-server](https://github.com/mattcoatsworth/zendesk-mcp-server)
- [koundinya/zd-mcp-server](https://github.com/koundinya/zd-mcp-server)

## Releases & versioning

Versions follow [SemVer](https://semver.org/) and are calculated **automatically** from commit messages — no one bumps the version by hand. Every merge to `main` triggers [semantic-release](https://github.com/semantic-release/semantic-release), which inspects the new [Conventional Commits](https://www.conventionalcommits.org/) since the previous tag, computes the next version, updates [`CHANGELOG.md`](CHANGELOG.md), publishes to npm, creates the matching GitHub Release, and mirrors the release into the [official MCP registry](https://registry.modelcontextprotocol.io) as [`io.github.fruggr/zendesk-mcp-server`](https://registry.modelcontextprotocol.io/?search=io.github.fruggr/zendesk-mcp-server) so registry-driven clients discover the new version automatically.

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
