# Configuration: CLI flags & environment variables

Full reference for configuring the [Zendesk MCP Server](../README.md): the CLI
flags and the environment variables. Each variable has its own anchor, so you can
deep-link a specific setting (e.g.
[`docs/configuration.md#zendesk_max_attachment_bytes`](#zendesk_max_attachment_bytes)).

CLI flags generally take precedence over the matching environment variable. The
one exception is `--cors-origin`, which is additive and *extends* `CORS_ORIGIN`
rather than replacing it. The server uses per-user OAuth 2.1 PKCE on every
transport; there is no static API-token mode (see
[What this server does *not* do](../README.md#what-this-server-does-not-do)).

## CLI reference

```
zendesk-mcp-server <subdomain> [options]

Options:
  --mode <mode>           single | namespace (default) | all
  --namespace <ns>        Filter by namespace (repeatable): tickets, help_center,
                          users, requests. Defaults to tickets + help_center +
                          users; `requests` (the end-user surface) is opt-in and
                          only ever exposed when asked for by name
  --tool <name>           Filter by tool name (repeatable, forces --mode all)
  --read-only             Only expose read operations
  --no-topology           Disable the Help Center structural context
                          (instructions + zendesk-hc://topology resource)
  --no-promoted-articles  Disable the promoted-article PRE-LISTING (the
                          <scheme>://article/{id} list scan + the
                          list_promoted_articles tool). Reading a known
                          article by id stays available.
  --hc-resource-scheme <scheme>
                          URI scheme of the Help Center resources
                          (default: zendesk-hc, i.e. zendesk-hc://topology);
                          bare RFC 3986 scheme, e.g. "wiki" — no "://"
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
  --print-tools           Print the tool surface these flags resolve to, then
                          exit. No server, no Zendesk credential, no network
                          call. Use it to check what a combination of --mode /
                          --namespace / --tool / --read-only actually exposes
```

`--namespace` and `--read-only` are applied before the proxies are registered, so they narrow the surface in every mode. In the default `namespace` mode, `--namespace help_center` registers a single proxy (`zendesk_help_center`) instead of the full set of namespace proxies.

Passing `--namespace` **replaces** the default set rather than adding to it, so
`--namespace requests` exposes the end-user surface *only*. To serve customers
the knowledge base as well, name both: `--namespace requests --namespace help_center`.

There is one way to pick the inventory (`--namespace` / `--tool`), `--mode`
packages it, and `--read-only` narrows it. When the combination is hard to
predict, don't guess — ask the server:

```bash
zendesk-mcp-server mycompany --print-tools --namespace requests --mode single
```

### A malformed invocation fails at startup

The server refuses to boot rather than run with config it cannot honour. These
shapes are rejected, each naming the knob at fault:

| Invocation | Why it is rejected |
| --- | --- |
| `--mode` (nothing after it) | the value was forgotten |
| `--mode ""` or `--mode=` | an empty value, typically `--mode "$VAR"` with `VAR` unset |
| `--host --read-only` | the value is another flag, so `--host` would swallow it |
| `--read-only=false` | a standalone flag takes no value |
| `--moed all` | an unknown flag. A typo is not silently ignored |
| `mycompany extra` | a second positional argument, so one of them would be dropped |

Values are never echoed back in these messages, so an unsupported flag written
as `--anything=<secret>` is reported by name alone, with the value withheld. For
the flags that take a value, both `--flag value` and `--flag=value` work;
standalone flags such as `--read-only` accept no value in either form.

Exactly one positional argument is read, as the subdomain. A repeatable flag
(`--namespace`, `--tool`, `--cors-origin`) has to be repeated:
`--namespace tickets --namespace help_center`. Writing
`--namespace tickets help_center` instead leaves `help_center` sitting where the
subdomain belongs.

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
effect without restarting the process or reconnecting the client. Unlike a file
watcher, the reload happens only when *you* call `reload_tools`, at the end of
an edit cycle and right before testing. That keeps the reload explicit and the
notification noise down to one burst per cycle. Point an MCP client's server
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
  server wiring itself) still require a full restart. A reload that throws, say
  on a syntax error caught mid-edit, returns a tool error and leaves the
  previous tools live: fix it and call `reload_tools` again.
- **Dev-only.** `reload_tools` is not part of the product tool surface and is
  never exposed without `--dev`; the published package ships compiled JS with no
  sources to reload. It is meant for `tsx`-from-source development.

## Environment variables

An **empty** variable is a misconfiguration, not "unset": `PORT=` in a compose
file, and `PORT="$VAR"` with `VAR` unset, both arrive as an empty string, and
applying the default there would boot a server whose config silently disagrees
with the deployment. Every single-value variable below therefore fails at
startup when set but empty, naming the variable. Unset it to get the default.

Three deliberate exceptions:

- `CORS_ORIGIN` is a *list*, where an empty value legitimately means "no extra
  origins" on top of the built-in allowlist.
- A variable that the command line overrides is never consulted, so `--port
  8080` alongside a stray `PORT=` still boots, and so does the positional
  `<subdomain>` alongside an empty `ZENDESK_SUBDOMAIN`. Validation applies to
  the value the server actually uses.
- The **numeric tuning caps** — `ZENDESK_CHARACTER_LIMIT`,
  `ZENDESK_MAX_ATTACHMENT_BYTES`, `ZENDESK_MAX_EMBEDDED_IMAGES`,
  `ZENDESK_MAX_COMMENT_PAGES`, `ZENDESK_REORDER_CONFIRM_THRESHOLD`,
  `ZENDESK_TICKET_FIELD_SCAN_MAX_PAGES` and
  `ZENDESK_ARTICLE_RESOURCES_SCAN_MAX_PAGES` — read through a shared parser that
  treats an empty value as unset and falls back to the default, along with any
  value that is not a positive safe integer. They bound response sizes and scan
  depth rather than describing the deployment, so a typo there degrades a
  guardrail instead of misrouting traffic, and refusing to boot over one would
  be the harsher failure.

### `ZENDESK_SUBDOMAIN`
**Required:** yes (or the CLI `<subdomain>` argument) · **Default:** none

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
**Required:** no · **Default:** none

Comma-separated browser origins added to the default CORS allowlist.

### `HC_RESOURCE_SCHEME`
**Required:** no · **Default:** `zendesk-hc`

URI scheme of the Help Center MCP resources (also `--hc-resource-scheme`, which
takes precedence). With the default, the topology resource is
`zendesk-hc://topology`; set `wiki`, for instance, to expose it as
`wiki://topology` and have the `instructions` blob cite that URI. It must be a
**bare RFC 3986 scheme**: a lowercase letter followed by lowercase letters,
digits, `+`, `-` or `.`. Anything else (`wiki://`, `Wiki`, `-wiki`, `1wiki`) is
rejected at startup. The WHATWG-special schemes (`http`, `https`, `ws`, `wss`,
`ftp`, `file`) are rejected too, because URL normalization appends a trailing
slash to them and that would make the advertised resource URI unreadable by MCP
clients. A generic scheme like `wiki` is safe collision-wise, since MCP resource
URIs are scoped per server; it is just less self-descriptive in a client
connected to several servers.

### `LOG_LEVEL`
**Required:** no · **Default:** `info`

Log verbosity (`debug` surfaces the full OAuth flow trace).

### `ZENDESK_CHARACTER_LIMIT`
**Required:** no · **Default:** `25000`

Ceiling on the characters a single tool response may carry. Past it the text is cut and a notice says what to do about it — the notice names a lever the tool in question actually accepts (a page parameter, a narrower filter, or the tool that pages the same data), so it differs per tool.

Raising it is rarely what you want: the default exists to protect the client's own context budget, and a larger response mostly moves the problem downstream. **Lowering it is the useful direction** — it is how the truncation paths get exercised on a tenant whose real data never reaches 25 000 characters. Set it to a few hundred and any ordinary response trips the notice:

```bash
ZENDESK_CHARACTER_LIMIT=2000 pnpm dev -- <your-subdomain> --mode all
```

### `ZENDESK_MAX_ATTACHMENT_BYTES`
**Required:** no · **Default:** `5242880` (5 MB)

Per-image size cap for inline (multimodal) ticket attachments. Images larger than this are returned as text references instead of embedded image content. The default is aligned with the Anthropic vision API per-image limit.

### `ZENDESK_MAX_EMBEDDED_IMAGES`
**Required:** no · **Default:** `10`

Maximum number of images embedded as native image content in a single tool call. Remaining images are returned as text references.

### `ZENDESK_MAX_COMMENT_PAGES`
**Required:** no · **Default:** `10`

Hard cap on the number of comment pages fetched when collecting a ticket's attachments (raise it for tickets with very long comment threads).

### `ZENDESK_TICKET_FIELD_SCAN_MAX_PAGES`
**Required:** no · **Default:** `10`

Hard cap on the number of `/ticket_fields` pages scanned when `get_request_form`
joins a request form to its field definitions. The scan exists because
`GET /ticket_fields/{id}` answers 403 for an end user, so the list is the only
way to a field's label and accepted values. Hitting the cap **fails the call**
rather than returning a partial list: a field missing from the join would leave
a required question unasked, and the submitter would meet an opaque Zendesk 422
instead. Raise it for an account with more portal fields than the default scan
covers.

### `ZENDESK_REORDER_CONFIRM_THRESHOLD`
**Required:** no · **Default:** `20`

Safety threshold for `reorder_article`. When moving an article would rewrite more than this many article positions (for example moving an article to the top of a large or heavily tied section), the tool refuses and reports the count until the call is retried with `confirm: true`. Lower it to be prompted sooner, raise it to reorder large sections without confirmation.

### `ZENDESK_ARTICLE_RESOURCES_SCAN_MAX_PAGES`
**Required:** no · **Default:** `20`

Hard cap on the number of article pages scanned to find promoted ("featured") articles. This backs both the `<scheme>://article/{id}` resource listing (`resources/list`) and the `list_promoted_articles` tool. The Help Center API has no server-side promoted filter, so the scan pages through the articles and filters them client-side; this bounds that scan on a very large Help Center (promoted articles beyond the cap are omitted, and the truncation is flagged). Raise it if promoted articles live deep in a large catalog.

**Cost note.** Each scanned page is one Zendesk API request, and Zendesk rate-limits every plan, so on a large Help Center a single listing or tool call can fan out to several requests. The resource-listing scan is cached per session for a few minutes (`ARTICLE_RESOURCES_TTL_MS`) so repeated `resources/list` calls coalesce; the `list_promoted_articles` tool performs a fresh, uncached scan on every call. The scan runs only when a resource-capable client calls `resources/list` or the LLM calls `list_promoted_articles`, never at connect. The worst case is a large catalog with few or no promoted articles: a full-cap scan for little result. If that matters for your tenant's quota, lower this cap or disable the pre-listing with **`--no-promoted-articles`**, which turns off the resource `list` scan **and** the `list_promoted_articles` tool, so the server makes **zero** preloading requests. It does **not** disable reading a known article by id (`<scheme>://article/{id}` stays registered): that is a cheap, on-demand single fetch, not a preload.

---

← Back to the [README](../README.md).
