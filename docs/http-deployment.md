# Remote HTTP deployment — Zendesk MCP Server

How to deploy the [Zendesk MCP Server](../README.md) as a private remote MCP
server over HTTP. For running it locally over stdio (the default, supported
path), see [Quick start: local](../README.md#quick-start-local-stdio).

> 🧪 **Experimental.** The HTTP transport is shipped but has not yet been
> exercised end-to-end against a real Zendesk tenant from every supported
> MCP client. Local stdio is the supported path. Until this notice is
> removed, expect rough edges around OAuth discovery behind reverse
> proxies, CORS with browser clients, and 401 / refresh flows — please
> open an issue with the symptoms you hit.

Deploy a private MCP server for **one** Zendesk account. Every MCP client connecting to the server presents its **own** user's OAuth bearer in `Authorization:` — the server never sees a shared admin key.

## Zendesk OAuth setup

Same procedure as the [local quick start](../README.md#zendesk-oauth-setup), with one difference: the **Redirect URL** must match the callback your MCP client uses — provided by the client itself, e.g. `https://claude.ai/oauth/callback` for claude.ai on the web. Check your client's docs.

## Run the server

```bash
zendesk-mcp-server <your-subdomain> --transport http --port 3000 \
  --public-url https://mcp.example.com
# stderr: Zendesk MCP server running via http on 0.0.0.0:3000
```

## Public URL

`--public-url` (or `PUBLIC_URL=…`) is the URL **clients use to reach you**. It's what gets advertised in the OAuth discovery metadata as the canonical resource identifier (RFC 8707). When the server is behind a TLS reverse proxy — Azure App Service, Heroku, Fly.io, Cloudflare Tunnel, nginx, Caddy… — the bind host and the public URL differ, and spec-compliant MCP clients will refuse the connection if the metadata advertises the wrong resource. Without it the server boots in a degraded mode and prints a warning.

| Platform | Recommended setup |
|---|---|
| **Azure App Service** | Startup command: `PUBLIC_URL="https://$WEBSITE_HOSTNAME" zendesk-mcp-server $ZENDESK_SUBDOMAIN --transport http --port $PORT` |
| **Heroku / Fly / Cloud Run** | `PUBLIC_URL=https://<your-app>.<provider>.app` in the env / config |
| **Caddy / nginx / Traefik in front of a VM** | `PUBLIC_URL=https://mcp.example.com` |
| **Local dev (no proxy)** | `--host 127.0.0.1 --port 3000` — the resource URL is derived automatically (the wildcard `0.0.0.0` is what triggers the warning) |

## Authentication on every request

`Authorization: Bearer …` is required on **every** `/mcp` request — a session id alone is never accepted as a credential. The most recent bearer presented on a session is the one used for Zendesk calls, so a client refreshing its token mid-session just works.

## Verify discovery endpoints

Served by the HTTP transport in `src/transports/http.ts`:

```bash
curl -s http://localhost:3000/.well-known/oauth-protected-resource
# → { "authorization_servers": ["https://<subdomain>.zendesk.com"], ... }

curl -s http://localhost:3000/.well-known/oauth-authorization-server
# → { "issuer": "https://<subdomain>.zendesk.com", "authorization_endpoint": "...", ... }

curl -s -i http://localhost:3000/healthz   # → 200 OK
```

## MCP client wiring

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

## CORS

The HTTP transport ships a default CORS allowlist that covers today's major **browser-based** MCP clients out of the box (ordered by user base): `chatgpt.com`, `claude.ai`, `gemini.google.com`, `copilot.microsoft.com`, `perplexity.ai`, `chat.mistral.ai`, `grok.com`, plus `chat.openai.com`. Localhost on any port (MCP Inspector, dev pages) is also always allowed.

**Native MCP clients** (Claude Desktop / Claude Code CLI / Cursor / VS Code / Zed) send no `Origin` header — CORS doesn't apply to them, they work regardless.

To allow an additional browser origin (custom dashboard, internal portal), pass `--cors-origin` (repeatable) or set `CORS_ORIGIN` as a comma-separated list:

```bash
zendesk-mcp-server acme --transport http --port 3000 \
  --cors-origin https://internal-dashboard.example.com \
  --cors-origin https://team-portal.example.com
```

The defaults are always applied — your additions extend them, they don't replace them.

## Operator responsibilities

This server provides the MCP transport and the OAuth discovery metadata. The operator is still responsible for:

- **TLS termination** (put the server behind a reverse proxy like Caddy / nginx / Cloudflare Tunnel)
- **Network exposure & firewall** (the server binds `0.0.0.0` by default — choose carefully)
- **Process supervision** (systemd, Docker, fly.io, your hosting provider's runner — none is shipped here)

See also [Configuration](configuration.md) for the full CLI and environment-variable reference.

---

← Back to the [README](../README.md).
