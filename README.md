# Zendesk MCP Server

[![Glama score](https://glama.ai/mcp/servers/fruggr/zendesk-mcp-server/badges/score.svg)](https://glama.ai/mcp/servers/fruggr/zendesk-mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.fruggr%2Fzendesk--mcp--server-0a7ea4)](https://registry.modelcontextprotocol.io/?search=io.github.fruggr/zendesk-mcp-server)
[![npm version](https://img.shields.io/npm/v/@fruggr/zendesk-mcp-server?logo=npm&color=cb3837)](https://www.npmjs.com/package/@fruggr/zendesk-mcp-server)
[![License: MIT](https://img.shields.io/npm/l/@fruggr/zendesk-mcp-server?color=blue)](LICENSE)
[![Node.js](https://img.shields.io/node/v/@fruggr/zendesk-mcp-server?logo=nodedotjs&logoColor=white&color=339933)](https://nodejs.org)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that
puts Zendesk inside your AI assistant, for **both sides of the conversation**.

**For agents**: it finds answers in the Help Center; drafts, updates and
translates articles while keeping the languages in sync; and handles Support
tickets end to end, comments, triage and image attachments included.

**For your customers**: it opens the same door the Help Center's "Submit a
request" form does. They pick the kind of request, get walked through the
questions that form actually asks, attach a screenshot, then follow the
ticket — read the replies, answer back, close it when it's resolved. See
[End-user mode](#end-user-mode).

It all happens in plain language, without switching apps.

It does roughly what the
[Zendesk agent for Microsoft 365 Copilot](https://support.zendesk.com/hc/en-us/articles/9958331458458-Using-the-Zendesk-agent-in-Microsoft-365-Copilot)
does, minus the tie to one vendor: it drops into any MCP client (Claude Desktop,
Claude Code, Cursor, VS Code, and the rest). And it always acts with each user's
own Zendesk permissions, never a shared admin key.

## What your assistant can do

Ask in natural language; the assistant works out the context and the intent,
then calls the right tools on your behalf.

- Find answers in the Help Center. "How do I request a software license?" or
  "what's the time-off policy?" surfaces the right article, matched by meaning
  rather than by keyword.
- Create, view and update tickets without leaving the conversation: open a
  ticket, check its status, add a public reply or an internal note, change the
  priority or the assignee, mark it solved.
- Summarize a ticket for a report or a quick decision. The assistant pulls the
  details and the full comment thread and gives you the gist in a sentence.
- Read the screenshots and photos attached to a ticket. Error dialogs, UI
  captures and product photos are handed to your assistant's own model as
  images, so it can describe them or act on what they show.
- Search and triage your queue in plain language: "show me my open tickets about
  billing from this week."
- Draft and maintain knowledge-base articles. You can write a new one, or revise
  a large one a single section at a time, so the whole HTML body never has to
  round-trip through the model.
- Submit and follow a request as a customer, not an agent. Choose between the
  kinds of request the vendor offers, answer only the questions that form asks,
  and then track it: what was replied, what you replied, and whether it's done.

## Why this server

Most Zendesk integrations run on a shared admin API key, which hands every user
full access to every ticket, and bolt on a fixed set of tools. This one is built
differently.

- Per-user authentication, OAuth only. Both transports use OAuth 2.1 PKCE: each
  user signs in with their own Zendesk credentials, so the assistant sees and
  touches exactly what that person is allowed to, the same scoping you get by
  signing into Zendesk directly. Static API tokens are deliberately not
  supported ([why](#what-this-server-does-not-do)).
- Two audiences, one server. Because auth is per-user rather than a shared admin
  key, the same install serves your agents and your customers — the end-user
  surface is a namespace you switch on, speaking the API path Zendesk reserves
  for requesters. Most Zendesk MCP servers are agent-only by construction.
- Section-based article editing. For large Help Center articles, read and
  rewrite one section at a time (parsed by `h1`/`h2`/`h3` headings) instead of
  shuffling the full HTML body through the assistant. On a targeted edit that
  cuts tokens by a factor of 10 to 100.
- Native multimodal attachments. Ticket images come back as native MCP image
  content, so the client's own model (Claude, GPT, Gemini, whichever) sees the
  pixels directly. No server-side vision model, no extra API key, and nothing
  tying you to one provider. Non-image attachments come back as text references,
  and both image caps are configurable.
- A tool surface you can cap. Expose every operation as its own tool, group them
  into namespace proxies, or collapse everything into a single unified tool. You
  can also filter by namespace or down to read-only operations, so each context
  loads only the surface it needs (see [Tool surface](#tool-surface)).
- Two deployment shapes, same auth story. Run it on your laptop as a stdio MCP
  server, or deploy it as a private remote MCP server reached over HTTP, with one
  Zendesk session per request and each client carrying its own user's token.
- A lean stack: the official `@modelcontextprotocol/sdk` plus `zod`, speaking to
  the Zendesk Support and Help Center (Guide) APIs.

Look elsewhere when:

- You need Zendesk products outside Support and Guide (Talk, Explore analytics,
  Sell). Those endpoints aren't covered.
- You need a single shared service account, or static API-token auth. This
  server supports neither, by design (see below).

## What this server does *not* do

There is no API-token authentication. The server speaks OAuth 2.1 PKCE and
nothing else: no `ZENDESK_EMAIL` + `ZENDESK_API_TOKEN` (Basic auth) mode, in any
transport. That is deliberate, for two reasons.

1. **API tokens are insufficiently secure.** A Zendesk API token is a
   long-lived, static, shared secret that carries the full rights of the user
   who issued it. There is no per-user scoping, no short expiry, and no per-user
   consent or revocation. OAuth 2.1 PKCE issues per-user, revocable tokens
   instead.
2. **API tokens don't scale.** A single static credential can't attribute
   actions to individual users, and it can't be revoked granularly. It also
   makes a multi-user remote deployment unsafe: over HTTP it would expose the
   issuing user's rights to every caller.

If you specifically need an API-token or service-account mode (headless CI with
a shared account, say), use one of the other Zendesk MCP servers that support
it. A few are listed under
[Inspiration & related projects](#inspiration--related-projects).

## Quick start: local (stdio)

The default shape: one developer, one Zendesk account, OAuth 2.1 PKCE in the
browser. You need **Node.js >= 20** and a **Zendesk** instance (Support or
Suite).

### Install

```bash
# Run without installing
npx -y @fruggr/zendesk-mcp-server <your-subdomain>

# Or install globally
npm install -g @fruggr/zendesk-mcp-server
zendesk-mcp-server <your-subdomain>
```

Signing in needs a Zendesk OAuth client, so register one first (next section).

### Zendesk OAuth setup

1. Go to **Admin Center → Apps and integrations → APIs → OAuth Clients**
2. Create a **public** client:
   - **Identifier**: `<your-subdomain>_zendesk` (or set `ZENDESK_OAUTH_CLIENT_ID`)
   - **Redirect URL**: `http://localhost:27439/callback` (change the port to match
     `ZENDESK_OAUTH_CALLBACK_PORT` / `--callback-port` if you override it; Zendesk
     accepts several redirect URLs, one per line)

On the first tool call the server starts the sign-in flow: it opens a browser
window and returns the authorize URL in a tool message. The call does not block
waiting for sign-in, so authenticate in the browser and then retry the request.
The token is persisted to an owner-only file and reused across restarts, so you
don't authenticate again every time your MCP client respawns the server (path
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

> **Experimental.** The HTTP transport ships, but it has not yet been exercised
> end-to-end against a real Zendesk tenant from every MCP client. Local stdio is
> the supported path.

You can also deploy a private remote MCP server for **one** Zendesk account,
where every MCP client presents its **own** user's OAuth bearer in
`Authorization:` and the server never sees a shared admin key. The full guide
covers OAuth setup, `--public-url` behind a reverse proxy, per-platform config,
the discovery endpoints, MCP client wiring, CORS and what stays the operator's
job: **[docs/http-deployment.md](docs/http-deployment.md)**.

## Tool surface

Tools are grouped into namespaces: **Tickets**, **Help Center**, **Users &
Organizations**, **Search**, and **Requests** — the end-user surface, which is
opt-in and covered under [End-user mode](#end-user-mode). The server registers
them in one of three modes, so you can trade granularity against context budget:

- **`all`**: every operation as its own tool, for clients with good tool selection;
- **`namespace`** (default): one proxy tool per namespace, a balanced middle ground;
- **`single`**: a single `zendesk` tool, for models with limited tool slots.

Proxies take `{ "operation": "<tool_name>", "params": { … } }` and validate
`params` through the original schema. `--namespace`, `--tool` and `--read-only`
filter tools *before* the proxies are built, so each proxy describes only the
operations that survive.

There's one way to pick the inventory (`--namespace` / `--tool`), `--mode`
packages it, and `--read-only` narrows it. When the combination isn't obvious,
don't guess — ask the server, which needs no credentials to answer:

```bash
zendesk-mcp-server mycompany --print-tools --namespace requests --mode single
```

Every tool with its description and its `read`/`write` mode:
**[docs/mcp-tools-reference.md](docs/mcp-tools-reference.md)**. The flags and
worked examples: **[docs/configuration.md](docs/configuration.md)**.

## End-user mode

The audience for everything above is a Zendesk **agent**. This section is about
the other one: your **customers**.

On the web, a customer opens a ticket through the Help Center's "Submit a
request" form — they pick a kind of request, fill in the fields that kind asks
for, attach a file, and later come back to read the replies. End-user mode is
that same journey, in their assistant.

### Who it's for

A vendor pointing their customers at an MCP server, so support happens where
those customers already work. They install it themselves, sign in with their
own Help Center account, and never see anything that isn't theirs.

### Turning it on

The end-user tools live in the `requests` namespace, which is **opt-in**:

```bash
zendesk-mcp-server mycompany --namespace requests --namespace help_center
```

`help_center` is worth adding — a customer who can search the knowledge base
often doesn't need to open a ticket at all.

Two things to know about the shape of that command. `--namespace` **replaces**
the default set rather than adding to it, so this exposes the end-user surface
only, not the agent tools as well. And `requests` is deliberately absent from
the default: an agent install shouldn't inherit tools built for someone else,
and one of them (marking a request solved) doesn't work under an agent token —
Zendesk accepts it and silently does nothing. `--print-tools` shows you exactly
what any combination of flags produces.

`--read-only` composes with it, if you want customers to follow their tickets
without opening new ones.

### The journey it supports

- **See what kinds of request are available.** The forms the vendor offers, by
  their customer-facing names.
- **Learn what one of them asks.** The questions on that form, which are
  required, and for dropdowns the exact choices — so the assistant can gather
  them in conversation instead of guessing at a payload.
- **Submit it**, with attachments.
- **Follow it.** List their requests, read one with its whole conversation
  (each reply attributed, and support agents marked as such), reply back, and
  mark it solved when it is.

### Zendesk prerequisites

- An **OAuth client** on the Zendesk account, with the local callback URL
  registered. Same client the agent side uses; nothing extra.
- The customer needs a **Help Center account** they can sign into. Signing in
  with a Google account is enough where the Help Center allows it — Zendesk
  provisions the user on first sign-in, with no admin action.
- At least one ticket form **visible to end users**. Accounts with several get
  a real choice; accounts with one get that one.

Sign-in is interactive, through a browser, by design — there's no scripted or
headless path to an end-user token. The step-by-step walkthrough, written for
someone who doesn't work in a terminal:
**[docs/end-user-onboarding.md](docs/end-user-onboarding.md)**.

### What a customer can't do — and shouldn't

A customer can do less than an agent. That's the point, not a gap:

- **Only their own tickets.** Enforced by Zendesk, not by us.
- **No internal notes**, in either direction. Agent-only notes never appear in
  what this surface returns — Zendesk filters them out of the requester's view
  of a ticket entirely.
- **No priority or type.** Zendesk drops both when a customer sets them;
  triage stays with the agents.
- **Closing a ticket only once an agent has picked it up.** Until then Zendesk
  won't let the requester solve it, so the tool says so rather than pretending.
- **No search across the ticket base**, no user lookups, no views, no macros.

## Help Center context

Beyond tools, the server hands the LLM the structure of *your* Help Center: the
active locales, the category → section tree with IDs, the visibility segments
and the permission groups. With those in hand it uses real IDs instead of
guessing or fuzzy-matching names. It all arrives through MCP-native channels,
namely the `instructions` blob sent on `initialize` plus pull-only resources for
the topology and for reading (or pinning) individual articles. The resources are
fetched with the caller's own token, and clients that don't support resources
ignore them silently.

What's exposed, what the promoted-article pre-listing costs in requests, and how
to turn each piece off: **[docs/help-center-context.md](docs/help-center-context.md)**.

## Configuration

The complete reference for the CLI flags (`--mode`, `--namespace`,
`--read-only`, `--transport`, `--public-url`, and so on) and the environment
variables (`ZENDESK_SUBDOMAIN`, `ZENDESK_TOKEN_FILE`, `PUBLIC_URL`, the
attachment-vision caps) lives in
**[docs/configuration.md](docs/configuration.md)**. Every variable has its own
anchor, so you can deep-link a specific setting.

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
No, and the server doesn't support one. Each user authenticates with their own
credentials and the server acts with exactly their permissions
([why](#what-this-server-does-not-do)).

**Is it safe to run via `npx`?**
Releases are published from CI via npm Trusted Publishing (OIDC), so each version
carries a build provenance attestation you can verify on its
[npm page](https://www.npmjs.com/package/@fruggr/zendesk-mcp-server). No secrets
are ever logged by the server.

## Contributing

Pull requests are welcome, AI-assisted ones included, as long as the human
author has read and validated every line. The guide, the author checklist and the
review workflow are in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

Versions follow [SemVer](https://semver.org/) and are released automatically from
[Conventional Commits](https://www.conventionalcommits.org/); the history is in
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
