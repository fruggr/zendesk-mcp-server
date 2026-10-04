# Remote HTTP deployment: Zendesk MCP Server

How to deploy the [Zendesk MCP Server](../README.md) as a private remote MCP
server over HTTP. For running it locally over stdio (the default, supported
path), see [Quick start: local](../README.md#quick-start-local-stdio).

> **Experimental.** The HTTP transport ships, but it has not yet been exercised
> end-to-end against a real Zendesk tenant from every supported MCP client.
> Local stdio is the supported path. Until this notice comes off, expect rough
> edges around OAuth discovery behind reverse proxies, CORS with browser
> clients, and 401 / refresh flows. Please open an issue with the symptoms you
> hit.

Deploy a private MCP server for **one** Zendesk account. The server is its own
OAuth authorization server: MCP clients register with it (Client ID Metadata
Document or Dynamic Client Registration), each user signs in to Zendesk through
it, and every tool call runs with that user's own Zendesk permissions. No shared
admin key, and no per-client setup in Zendesk. Why it works this way:
[the ADR](decisions/oauth-authorization-server.md).

## Zendesk OAuth setup

Reuse the OAuth client of the [local quick start](../README.md#zendesk-oauth-setup):
the same public PKCE client, the same `ZENDESK_OAUTH_CLIENT_ID`, no client
secret. Add one **Redirect URL** to it:

```
<public-url>/oauth/callback
```

for example `https://mcp.example.com/oauth/callback`, or
`http://localhost:3000/oauth/callback` for a local run. That single URL serves
every MCP client: they never talk to Zendesk directly.

## Install

The package carries everything the HTTP transport needs, so the stdio install
works as is: `npm install @fruggr/zendesk-mcp-server` (or `npx -y
@fruggr/zendesk-mcp-server ...`). Nothing else gets installed next to it.

## Run the server

```bash
zendesk-mcp-server <your-subdomain> --transport http --port 3000 \
  --public-url https://mcp.example.com
# stderr: http_transport_ready ... issuer=https://mcp.example.com
```

That is enough to start: the master secret is generated on first start and the
grants are kept in a file, both in the config directory (next section). For a
deployment, supply both explicitly.

## Container

Each release publishes `ghcr.io/fruggr/zendesk-mcp-server` with the same version
as npm. It runs the same bundle, on a distroless
[Docker Hardened Images](https://docs.docker.com/dhi/) Node base: no shell, no
package manager, a non-root user (UID 1000).

**What the image is for, and what it is not for.**

- **HTTP only.** The image starts `--transport http` by default
  (`TRANSPORT=http`). stdio in a container is not supported: use `npx` for that
  ([#344](https://github.com/fruggr/zendesk-mcp-server/issues/344)).
- **`linux/amd64` only**
  ([#345](https://github.com/fruggr/zendesk-mcp-server/issues/345)).
- No `HEALTHCHECK`: point your orchestrator's probes at `GET /healthz`.

```bash
docker run --read-only --cap-drop ALL --security-opt no-new-privileges \
  -e OAUTH_MASTER_SECRET="$(cat /run/secrets/zendesk-mcp-master-secret)" \
  -v zendesk-mcp-data:/data -p 3000:3000 \
  ghcr.io/fruggr/zendesk-mcp-server:3 <your-subdomain> \
  --public-url https://mcp.example.com
```

- **`/data` is the only writable path.** The grant store defaults to
  `file:///data/oauth-store.json` (`OAUTH_STORE`), so mount a persistent volume
  there. The root filesystem can stay read-only.
- **The secret comes from the environment.** It never lives on `/data`, next to
  the store (see [Master secret and grant store](#master-secret-and-grant-store)).
  Without one, the container stops at startup with an error saying so, rather
  than writing a secret it could not keep.
- **One replica, same secret and store across redeploys**: a redeploy then logs
  nobody out.
- **Tags.** `X.Y.Z`, `X.Y`, `X` and `latest`. When the base image gets a fix
  and no release is due, the latest release is rebuilt on it and its tags move
  to the new digest, `X.Y.Z` included. To pin, pin the digest.
- **Verify what you pull.** Each image is signed keyless with cosign and carries
  build provenance and an SBOM of the bundled packages. A tag moves to a new
  digest only once that digest is signed and attested:

```bash
gh attestation verify oci://ghcr.io/fruggr/zendesk-mcp-server:3 --owner fruggr
cosign verify ghcr.io/fruggr/zendesk-mcp-server:3 \
  --certificate-identity-regexp '^https://github.com/fruggr/zendesk-mcp-server/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Master secret and grant store

The server signs and encrypts its own tokens, and encrypts what it stores, with
keys derived from one **master secret**. It belongs to this server, not to
Zendesk.

| | Default | For a deployment |
|---|---|---|
| **Master secret** | Generated on first start into `oauth-master-secret` (mode 0600) in the config directory | `OAUTH_MASTER_SECRET` from a secret manager (e.g. a Key Vault reference on Azure Container Apps), or `--oauth-master-secret-file` |
| **Grant store** | `file://<config dir>/oauth-store.json` | `--oauth-store file:///data/oauth-store.json` on a persistent volume |

- **Generate a secret** with `openssl rand -base64 32`. Anything under 32 bytes
  is refused at startup.
- **Keep the secret off the store's volume.** Together they expose the users'
  Zendesk refresh tokens; apart, the store is unreadable. The server warns when
  an auto-generated secret sits next to a file store.
- **Keep both across redeploys.** With the same secret and store, a restart or a
  redeploy logs nobody out. Lose either and every user signs in again.
- **A file is the only persistent store.** `memory://` keeps everything in
  memory, for tests only.
- **One instance only.** Several replicas sharing a store are not supported.

### Rotating the secret

`OAUTH_MASTER_SECRET` takes a comma-separated list, newest first: the first entry
signs and encrypts, every entry still decrypts.

1. Prepend a new secret: `OAUTH_MASTER_SECRET=<new>,<old>`, and redeploy.
2. After 90 days (the longest a refresh token lives), drop the old one.

A record read in the meantime is re-encrypted under the new secret. Users whose
records are still under the old one when you drop it sign in again.

**If the secret leaked**, replace the list outright (no old entry): every token
becomes invalid and every user signs in again. If the store may have leaked
too, also revoke the users' OAuth tokens at Zendesk, which still honours them
until they expire.

## Trusted clients and consent

Users sign in to Zendesk and approve the Zendesk consent screen. The server adds
its own consent screen, once per client and user, for any client it cannot vouch
for: clients registered through DCR, unknown CIMD clients, and clients whose
redirect is a loopback address (Claude Code, Codex, VS Code, Zed, ...).

**claude.ai and ChatGPT skip it**: their client id is on a built-in allowlist,
and the redirect they ask for is HTTPS and listed in the document served on
their own domain, so the code cannot be diverted.

- `--oauth-trusted-client <client-id-url>` (repeatable) or
  `OAUTH_TRUSTED_CLIENTS` (comma-separated) adds a CIMD client to the allowlist.
  The same HTTPS rules apply to it.
- `--no-default-trusted-clients` drops the built-in entries.

## Outbound access

The server makes HTTPS requests to two kinds of hosts:

- **Zendesk** (`<subdomain>.zendesk.com`), for sign-in, token refresh and every
  tool call;
- **client document hosts**: claude.ai and chatgpt.com, plus any other host
  that serves a CIMD client's metadata document, at sign-in and token refresh.

Some document hosts sit behind bot protection that judges the requesting IP's
reputation, and shared egress IPs of cloud providers sometimes fail it. For a
client its users have signed in with, the server then keeps working on the last
copy it kept, for up to 7 days, and logs `oauth_client_fetch_failed`. If that
persists, give the server a dedicated egress IP, for example through a NAT
gateway with a static IP
([troubleshooting](troubleshooting.md#http-the-log-shows-oauth_client_fetch_failed)).

The change has to happen at the network level. Document fetches go through
`oidc-provider`'s own SSRF-guarded HTTP agent, which ignores `HTTPS_PROXY` and
`NODE_USE_ENV_PROXY`, so an HTTP proxy set through the environment is not used.

## Public URL

`--public-url` (or `PUBLIC_URL=…`) is the URL **clients use to reach you**. It's what gets advertised in the OAuth discovery metadata as the canonical resource identifier (RFC 8707). Behind a TLS reverse proxy (Azure App Service, Heroku, Fly.io, Cloudflare Tunnel, nginx, Caddy…) the bind host and the public URL differ, and a spec-compliant MCP client refuses the connection when the metadata advertises the wrong resource. Without it the server boots in a degraded mode and prints a warning.

| Platform | Recommended setup |
|---|---|
| **Azure App Service** | Startup command: `PUBLIC_URL="https://$WEBSITE_HOSTNAME" zendesk-mcp-server $ZENDESK_SUBDOMAIN --transport http --port $PORT` |
| **Heroku / Fly / Cloud Run** | `PUBLIC_URL=https://<your-app>.<provider>.app` in the env / config |
| **Caddy / nginx / Traefik in front of a VM** | `PUBLIC_URL=https://mcp.example.com` |
| **Local dev (no proxy)** | `--host 127.0.0.1 --port 3000`, and the resource URL is derived automatically (the wildcard `0.0.0.0` is what triggers the warning) |

## Authentication on every request

`Authorization: Bearer …` is required on **every** `/mcp` request, and only an
access token this server issued for its `/mcp` resource is accepted. A Zendesk
token presented directly gets a `401`: the server never passes a token through.
A session id alone is never a credential, and a session only accepts tokens of
the user who opened it. The most recent token presented on a session is the one
used, so a client refreshing mid-session just works. A token granted `read`
alone gets the read tools only, as if the server ran `--read-only`, and cannot
drive a session opened with `write`.

Access tokens last one hour; refresh tokens up to 90 days, like Zendesk's own.
The server refreshes the user's Zendesk token by itself when needed. If Zendesk
rejects it (the user revoked the app, an admin revoked the token), the tool call
fails with an authentication error and the client's next request gets a `401`,
which makes it sign the user in again. A Zendesk outage during a refresh does not end the grant by itself,
but most MCP clients are public clients, whose refresh token is already spent by
then: their retry is a replay, which signs the user out.

## Verify discovery endpoints

```bash
curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp
# → { "resource": "http://localhost:3000/mcp", "authorization_servers": ["http://localhost:3000"], ... }

curl -s http://localhost:3000/.well-known/oauth-authorization-server
# → { "issuer": "http://localhost:3000", "registration_endpoint": "...",
#     "client_id_metadata_document_supported": true, ... }

curl -s -i http://localhost:3000/healthz   # → 200 OK
```

`scopes_supported` follows `--read-only`: `["read", "write"]` normally, `["read"]`
on a read-only server, which then also asks Zendesk for `read` only.

## MCP client wiring

Every major MCP client supports remote servers over Streamable HTTP and handles the OAuth 2.1 PKCE discovery flow natively: paste the URL, sign in once, you're connected. Replace `https://mcp.example.com` below with your deployed origin.

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

On the first call the MCP client fetches the discovery metadata, registers with the server, and runs the OAuth 2.1 PKCE flow against it. The server sends the user to Zendesk to sign in, then hands the client an access token of its own. Each subsequent tool call runs with that user's Zendesk permissions.

## CORS

The HTTP transport ships a default CORS allowlist that covers today's major **browser-based** MCP clients out of the box (ordered by user base): `chatgpt.com`, `claude.ai`, `gemini.google.com`, `copilot.microsoft.com`, `perplexity.ai`, `chat.mistral.ai`, `grok.com`, plus `chat.openai.com`. Localhost on any port (MCP Inspector, dev pages) is also always allowed.

**Native MCP clients** (Claude Desktop / Claude Code CLI / Cursor / VS Code / Zed) send no `Origin` header, so CORS doesn't apply to them and they work regardless.

To allow an additional browser origin (custom dashboard, internal portal), pass `--cors-origin` (repeatable) or set `CORS_ORIGIN` as a comma-separated list:

```bash
zendesk-mcp-server acme --transport http --port 3000 \
  --cors-origin https://internal-dashboard.example.com \
  --cors-origin https://team-portal.example.com
```

The defaults are always applied: your additions extend them, they don't replace them.

## Long-lived SSE streams behind a proxy

Streamable HTTP keeps some responses open as an SSE stream, and the SDK maintains them itself: a comment frame roughly every 15 seconds (its default, not ours), well under the 60 seconds nginx (`proxy_read_timeout`) and AWS ALB (idle timeout) default to. Caddy sets no stream timeout at all. No proxy-side tuning needed either way.

Every SSE response also carries `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform`, so the classic "SSE arrives in bursts behind nginx" fix is obsolete — don't re-apply it.

The heartbeat does **not** keep the *session* alive: the idle sweeper evicts it after 30 minutes with no inbound `/mcp` request, however healthy the stream looks. See [My HTTP session disappears after a pause](troubleshooting.md#my-http-session-disappears-after-a-pause-even-though-the-stream-stayed-up).

## Operator responsibilities

This server provides the MCP transport and the OAuth authorization server. The operator is still responsible for:

- The master secret and the grant store: supply the secret from a secret manager, keep the store on a persistent volume, and keep the two apart (see [Master secret and grant store](#master-secret-and-grant-store)).
- TLS termination. Put the server behind a reverse proxy like Caddy, nginx or Cloudflare Tunnel, which must forward `X-Forwarded-Proto` and `X-Forwarded-Host`: with an `https` public URL the server trusts them to build its endpoint URLs.
- Network exposure and firewalling. The server binds `0.0.0.0` by default, so choose carefully.
- Process supervision: the [container image](#container) on an orchestrator (Azure Container Apps, Kubernetes, Cloud Run), or your own runner (systemd, fly.io).

## Stopping the server

`SIGINT` and `SIGTERM` drain the live sessions, close the listening socket and
exit `0`. A shutdown that cannot finish within a few seconds is forced rather
than left hanging, so the server always exits well inside the grace its
supervisor allows before `SIGKILL` — 10s for `docker stop`, 30s for Kubernetes.

Stdin is ignored in HTTP mode: closing it does nothing, and the server has no
client there to lose. Only signals stop it. The stdio transport deliberately does
the opposite — see [Process lifecycle](decisions/lifecycle-shutdown.md).

See also [Configuration](configuration.md) for the full CLI and environment-variable reference.

---

← Back to the [README](../README.md).
