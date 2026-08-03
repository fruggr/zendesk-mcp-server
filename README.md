# Zendesk MCP Server

[![Glama score](https://glama.ai/mcp/servers/fruggr/zendesk-mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/fruggr/zendesk-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.fruggr%2Fzendesk--mcp--server-0a7ea4)](https://registry.modelcontextprotocol.io/?search=io.github.fruggr/zendesk-mcp-server)
[![npm version](https://img.shields.io/npm/v/@fruggr/zendesk-mcp-server?logo=npm&color=cb3837)](https://www.npmjs.com/package/@fruggr/zendesk-mcp-server)
[![License: MIT](https://img.shields.io/npm/l/@fruggr/zendesk-mcp-server?color=blue)](LICENSE)
[![Node.js](https://img.shields.io/node/v/@fruggr/zendesk-mcp-server?logo=nodedotjs&logoColor=white&color=339933)](https://nodejs.org)

**Bring Zendesk deep into your AI assistant.** A
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server: find
answers in the Help Center, **draft, update and translate** articles (keeping
languages in sync), and **manage Support tickets** end to end — comments, triage
and image attachments — all in plain language, **without switching apps**.

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

## Why this server

Most Zendesk integrations use a shared admin API key, giving every user full
access to every ticket, and bolt on a fixed set of tools. This one is built
differently:

- **Per-user authentication, OAuth-only.** Both transports use OAuth 2.1 PKCE:
  each user signs in with their own Zendesk credentials, so the assistant sees
  and touches exactly what that person is allowed to — the same scoping you'd get
  signing into Zendesk directly. Static API tokens are deliberately **not**
  supported ([why](#what-this-server-does-not-do)).
- **Section-based article editing.** For large Help Center articles, read and
  rewrite one section at a time (parsed by `h1`/`h2`/`h3` headings) instead of
  shuffling the full HTML body through the assistant. Reduces tokens by 10–100×
  on targeted edits.
- **Native multimodal attachments.** Ticket images are returned as native MCP
  image content, so the **client's own model** (Claude, GPT, Gemini, …) sees the
  pixels directly: no server-side vision model, no extra API key, no lock-in to
  one provider. Non-image attachments come back as text references, and both
  image caps are configurable.
- **A tool surface you can cap.** Expose every operation as its own tool, group
  them into namespace proxies, or collapse to a single unified tool — and filter
  by namespace or to read-only operations, so each context loads only the surface
  it needs (see [Tool surface](#tool-surface)).
- **Two deployment shapes, same auth story.** Run it on your laptop as a stdio
  MCP server, or deploy it as a private remote MCP server reached over HTTP —
  one Zendesk session per request, each client carrying its own user's token.
- **Lean stack.** The official `@modelcontextprotocol/sdk` plus `zod`, speaking
  to the Zendesk Support & Help Center (Guide) APIs.

**Look elsewhere when:**

- You need Zendesk products outside Support & Guide (Talk, Explore analytics,
  Sell) — those endpoints aren't covered.
- You need a single shared service account, or static API-token auth — this
  server supports neither, by design (see below).

## What this server does *not* do

**No API-token authentication.** This server is OAuth 2.1 PKCE only — there is no
`ZENDESK_EMAIL` + `ZENDESK_API_TOKEN` (Basic auth) mode, in any transport. This is
a deliberate design choice:

- **API tokens are insufficiently secure.** A Zendesk API token is a long-lived,
  static, shared secret carrying the full rights of the issuing user — no per-user
  scoping, no short expiry, no per-user consent or revocation. OAuth 2.1 PKCE
  issues per-user, revocable tokens instead.
- **API tokens don't scale.** A single static credential can't attribute actions
  to individual users or be revoked granularly, and it makes a multi-user remote
  deployment unsafe: over HTTP it would expose the issuing user's rights to every
  caller.

If you specifically need an API-token / service-account mode (e.g. headless CI
with a shared account), use one of the other Zendesk MCP servers that support it
— see [Inspiration & related projects](#inspiration--related-projects).

## Quick start: local (stdio)

The default shape: one developer, one Zendesk account, OAuth 2.1 PKCE in the
browser. Requires **Node.js >= 20** and a **Zendesk** instance (Support or Suite).

### Install

```bash
# Run without installing
npx -y @fruggr/zendesk-mcp-server <your-subdomain>

# Or install globally
npm install -g @fruggr/zendesk-mcp-server
zendesk-mcp-server <your-subdomain>
```

Sign-in needs a Zendesk OAuth client — register one first (next section).

### Zendesk OAuth setup

1. Go to **Admin Center → Apps and integrations → APIs → OAuth Clients**
2. Create a **public** client:
   - **Identifier**: `<your-subdomain>_zendesk` (or set `ZENDESK_OAUTH_CLIENT_ID`)
   - **Redirect URL**: `http://localhost:27439/callback` (change the port to match
     `ZENDESK_OAUTH_CALLBACK_PORT` / `--callback-port` if you override it; Zendesk
     accepts several redirect URLs, one per line)

On the first tool call the server starts the sign-in flow: it opens a browser
window **and** returns the authorize URL in a tool message. The call does not
block waiting for sign-in — authenticate in the browser, then retry the request.
The token is then persisted to an owner-only file and reused across restarts, so
you don't re-authenticate every time your MCP client respawns the server (path
and overrides: [`ZENDESK_TOKEN_FILE`](docs/configuration.md#zendesk_token_file)).

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

Something not working? See [Troubleshooting](docs/troubleshooting.md).

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

## Tool surface

Tools are grouped into four namespaces — **Tickets**, **Help Center**,
**Users & Organizations** and **Search** — and the server registers them in one of
three modes, so you can trade granularity against context budget:

- **`all`** — every operation as its own tool, for clients with good tool selection;
- **`namespace`** (default) — one proxy tool per namespace, a balanced middle ground;
- **`single`** — a single `zendesk` tool, for models with limited tool slots.

Proxies take `{ "operation": "<tool_name>", "params": { … } }` and validate
`params` through the original schema. `--namespace`, `--tool` and `--read-only`
filter tools **before** the proxies are built, so each proxy describes only the
operations that survive.

Every tool with its description and its `read`/`write` mode:
**[docs/mcp-tools-reference.md](docs/mcp-tools-reference.md)**. The flags and
worked examples: **[docs/configuration.md](docs/configuration.md)**.

## Help Center context

Beyond tools, the server hands the LLM the structure of *your* Help Center — the
active locales, the category → section tree with IDs, the visibility segments and
permission groups — so it uses real IDs instead of guessing or fuzzy-matching
names. It arrives through MCP-native channels: the `instructions` blob sent on
`initialize`, plus pull-only resources for the topology and for reading (or
pinning) individual articles. Each is fetched with the caller's own token, and
clients that don't support resources ignore them silently.

What's exposed, what the promoted-article pre-listing costs in requests, and how
to turn each piece off: **[docs/help-center-context.md](docs/help-center-context.md)**.

## Configuration

The complete reference for the CLI flags (`--mode`, `--namespace`, `--read-only`,
`--transport`, `--public-url`, …) and the environment variables
(`ZENDESK_SUBDOMAIN`, `ZENDESK_TOKEN_FILE`, `PUBLIC_URL`, the attachment-vision
caps, …) lives in **[docs/configuration.md](docs/configuration.md)** — with a
per-variable anchor so you can deep-link a specific setting.

## Troubleshooting

Browser not opening during OAuth login, the callback port already in use, having
to re-authenticate every time, and `Permission denied` on the Guide-admin
endpoints are covered in **[docs/troubleshooting.md](docs/troubleshooting.md)**.
Restart with `LOG_LEVEL=debug` for the full OAuth flow trace.

## Development

Setting up the repo, the toolchain, dev mode and how to test a PR branch are
covered in **[CONTRIBUTING.md](CONTRIBUTING.md#development-setup)**. Architecture
and code-style conventions live in [`AGENTS.md`](AGENTS.md).

## FAQ

**Which Zendesk products are supported?**
Zendesk Support (tickets, users, organizations) and the Help Center / Guide
(articles, sections, categories, translations, labels, content tags, segments,
attachments). Talk, Explore and Sell are out of scope.

**Do I need a Zendesk admin API key?**
No — and the server doesn't support one. Each user authenticates with their own
credentials and the server acts with exactly their permissions
([why](#what-this-server-does-not-do)).

**Is it safe to run via `npx`?**
Releases are published from CI via npm Trusted Publishing (OIDC), so each version
carries a build provenance attestation you can verify on its
[npm page](https://www.npmjs.com/package/@fruggr/zendesk-mcp-server). No secrets
are ever logged by the server.

## Contributing

Pull requests are welcome — including AI-assisted ones, as long as the human
author has read and validated every line. The guide, the author checklist and the
review workflow are in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

Versions follow [SemVer](https://semver.org/) and are released automatically from
[Conventional Commits](https://www.conventionalcommits.org/) — see
[`CHANGELOG.md`](CHANGELOG.md).

## Inspiration & related projects

This project was built with reference to:
- The official [Zendesk API documentation](https://developer.zendesk.com/api-reference/)
- [mattcoatsworth/zendesk-mcp-server](https://github.com/mattcoatsworth/zendesk-mcp-server)
- [koundinya/zd-mcp-server](https://github.com/koundinya/zd-mcp-server)

## License

[MIT](LICENSE)

---

> Built and maintained by [Digital4better](https://digital4better.com) for the [Fruggr](https://www.fruggr.io) project.
