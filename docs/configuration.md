# Configuration — CLI flags & environment variables

Full reference for configuring the [Zendesk MCP Server](../README.md): the CLI
flags and the environment variables. Each variable has its own anchor, so you can
deep-link a specific setting (e.g.
[`docs/configuration.md#zendesk_max_attachment_bytes`](#zendesk_max_attachment_bytes)).

CLI flags generally take precedence over the matching environment variable; the
exception is `--cors-origin`, which is additive and *extends* `CORS_ORIGIN`
rather than replacing it. The server uses per-user OAuth 2.1 PKCE for every
transport — there is no static API-token mode (see
[What this server does *not* do](../README.md#what-this-server-does-not-do)).

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
  --dev                   Dev-only: expose a reload_tools tool that hot-reloads
                          edited tool code on demand (stdio only; see "Dev mode"
                          below)
```

`--namespace` and `--read-only` are applied before the proxies are registered, so they narrow the surface in every mode — in the default `namespace` mode, `--namespace help_center` registers a single proxy (`zendesk_help_center`) instead of the full set of namespace proxies.

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

## Dev mode (`--dev`)

A development-loop convenience for iterating on tool code. With `--dev` the
server exposes one extra tool, **`reload_tools`**. Calling it re-imports the
tool modules from source and re-registers the toolset **in place** on the
running server: the client is notified via `notifications/tools/list_changed`
and refetches, so tool descriptions, schemas and handlers you just edited take
effect **without restarting the process or reconnecting the client**. Unlike a
file watcher, the reload happens only when *you* call `reload_tools` — at the
end of an edit cycle, right before testing — which keeps the reload explicit and
the notification noise to one burst per cycle. Point an MCP client's server
command at the source and add the flag:

```jsonc
// .mcp.json
{
  "command": "pnpm",
  "args": ["exec", "tsx", "src/index.ts", "--mode", "all", "--dev"],
  "env": { "ZENDESK_SUBDOMAIN": "acme" }
}
```

Scope and limits, by design:

- **stdio only.** HTTP builds a fresh server per request, so there is nothing
  long-lived to hot-swap; the flag is ignored (with a warning) in HTTP mode.
- **Tool code only.** Reload re-imports the leaf tool modules
  (`src/tools/{tickets,search,help-center,users}.ts`). Edits to shared
  infrastructure below them (the HTTP client, `definitions.ts`, guidance, or the
  server wiring itself) still require a full restart. A reload that throws (e.g.
  a syntax error mid-edit) returns a tool error and leaves the previous tools
  live — fix and call `reload_tools` again.
- **Dev-only.** `reload_tools` is not part of the product tool surface and is
  never exposed without `--dev`; the published package ships compiled JS with no
  sources to reload. It is meant for `tsx`-from-source development.

## Environment variables

### `ZENDESK_SUBDOMAIN`
**Required:** yes (or the CLI `<subdomain>` argument) · **Default:** —

Zendesk subdomain (e.g. `acme` for `acme.zendesk.com`).

### `ZENDESK_OAUTH_CLIENT_ID`
**Required:** no · **Default:** `<subdomain>_zendesk`

OAuth client identifier.

### `ZENDESK_OAUTH_CALLBACK_PORT`
**Required:** no · **Default:** `27439`

Local port for the OAuth browser callback (also `--callback-port`). Must match the redirect URL registered in Zendesk. **stdio only.**

### `ZENDESK_TOKEN_FILE`
**Required:** no · **Default:** OS config dir

Path to the persisted OAuth token file (`0600`).

### `TRANSPORT`
**Required:** no · **Default:** `stdio`

`stdio` or `http`.

### `HOST`
**Required:** no · **Default:** `0.0.0.0`

HTTP bind host.

### `PORT`
**Required:** no · **Default:** `3000`

HTTP bind port (`0` to let the OS pick).

### `PUBLIC_URL`
**Required:** recommended in HTTP behind a proxy · **Default:** derived from `host:port`

Public URL advertised in OAuth discovery metadata. See [Public URL](http-deployment.md#public-url).

### `CORS_ORIGIN`
**Required:** no · **Default:** —

Comma-separated browser origins added to the default CORS allowlist.

### `LOG_LEVEL`
**Required:** no · **Default:** `info`

Log verbosity (`debug` surfaces the full OAuth flow trace).

### `ZENDESK_MAX_ATTACHMENT_BYTES`
**Required:** no · **Default:** `5242880` (5 MB)

Per-image size cap for inline (multimodal) ticket attachments. Images larger than this are returned as text references instead of embedded image content. The default is aligned with the Anthropic vision API per-image limit.

### `ZENDESK_MAX_EMBEDDED_IMAGES`
**Required:** no · **Default:** `10`

Maximum number of images embedded as native image content in a single tool call. Remaining images are returned as text references.

### `ZENDESK_MAX_COMMENT_PAGES`
**Required:** no · **Default:** `10`

Hard cap on the number of comment pages fetched when collecting a ticket's attachments (raise it for tickets with very long comment threads).

---

← Back to the [README](../README.md).
