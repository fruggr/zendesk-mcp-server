# Troubleshooting: Zendesk MCP Server

Common issues running the [Zendesk MCP Server](../README.md) and how to diagnose
them. See also [Configuration](configuration.md) for the flags and environment
variables referenced below.

## The server refuses to start and names a flag or a variable

The server would rather not boot than run with config it cannot honour, so a
malformed invocation fails immediately. The message names the knob at fault, and
never repeats the value you passed: a mistyped `--token=<secret>` reports only
the flag name.

| What you get | What to look for |
| --- | --- |
| `option '--mode <value>' argument missing` | the flag is the last thing on the command line; its value was forgotten |
| `Empty value for --mode.` | the value is an empty string, usually `--mode "$VAR"` with `VAR` unset in the shell or compose file |
| `Option '--host' argument is ambiguous` | the next token is another flag, so `--host` would have swallowed it. To pass a value that really does start with a dash, use `--host=-value` |
| `Unknown option '--moed'` | a typo, or a flag from a different version. Check it against the [CLI reference](configuration.md#cli-reference) |
| `Option '--read-only' does not take an argument` | a standalone flag was given a value |
| `Expected one positional argument (the subdomain), got 2.` | a stray argument. Most often a repeatable flag given a space-separated list, where `--namespace tickets --namespace help_center` is the right form |
| `Empty PORT. Set it to a value, or unset it entirely.` | the variable is set but empty. Remove it entirely to fall back to the default |

The rows starting `option` / `Option` / `Unknown option` come from Node's own
argument parser, so treat that wording as indicative rather than exact. It can
change between Node releases. The `Empty ...` and `Expected one positional ...`
messages are ours and stable.

Two things that are *not* errors: `CORS_ORIGIN=` is a valid way to say "no extra
origins", and a variable that a CLI flag overrides is never read, so `--port
8080` alongside a stray `PORT=` starts normally.

If a deployment that used to work now fails here, that is the point. It was
running with config that had been silently dropped. The most common case is an
empty `HC_RESOURCE_SCHEME`, which used to fall back to `zendesk-hc` while
runbooks expected a branded scheme.

## The browser doesn't open during OAuth login

The OAuth flow opens your default browser on the first tool call. That first call
fails fast with a message that includes the authorize URL, so even if the
browser can't open (common in sandboxed or remote desktop environments) you can
open that URL manually. It's also printed to the server's stderr. Sign in, then
retry the request.

To collect diagnostics, restart with `LOG_LEVEL=debug`. The server then emits
structured logs through **two channels**, so they're reachable on any MCP client:

- stderr, captured to a log file by every mainstream client.
- MCP logging notifications (`notifications/message`), surfaced by clients that
  support the `logging` capability.

When the browser fails to open, look for the `oauth_browser_open_failed` event:
it reports the underlying error, the platform, and which environment markers are
present (no secrets, tokens, or env values are ever logged).

## The OAuth callback port is already in use

The sign-in flow runs a short-lived local server on port `27439` to receive the
callback. If that port is taken, the first tool call fails with a message saying
so (and logs `oauth_callback_listen_failed`). Pick a free port with
`ZENDESK_OAUTH_CALLBACK_PORT=<port>` (or `--callback-port <port>`), and register
the matching `http://localhost:<port>/callback` redirect URL in your Zendesk
OAuth client.

## I have to re-authenticate every time

The OAuth token is persisted to an owner-only (`0600`) file in your OS config
dir, one per subdomain, and reused across restarts, so this shouldn't happen:

- `%APPDATA%\fruggr\zendesk-mcp-server\<subdomain>.json` on Windows;
- `${XDG_CONFIG_HOME:-$HOME/.config}/fruggr/zendesk-mcp-server/<subdomain>.json`
  elsewhere.

If the Zendesk OAuth client has token expiration enabled, the stored refresh
token renews access silently, in two ways. It refreshes **proactively**, before
use, when the token is expired, near expiry or of unknown age, so the first
request after an overnight gap never surfaces an auth error. And it refreshes
**periodically** in the background, so a long-lived idle session never serves a
stale token. Only an expired or invalid refresh token triggers a new browser
sign-in.

If you still re-authenticate every time, check that the file is writable
([`ZENDESK_TOKEN_FILE`](configuration.md#zendesk_token_file) to relocate it) and
look for `token_persist_failed` in the logs.

## `Permission denied` on `list_permission_groups`, `list_user_segments`, or the topology resource

Enumerating Guide permission groups and Help Center user segments requires
**Guide-admin / Help Center manager** rights, a tier above the per-article edit
rights an agent may already have. A content-editor token gets HTTP `403` on those
two endpoints. This does **not** block content editing: the `zendesk-hc://topology`
resource degrades gracefully (the two admin-only sections are marked *unavailable*
rather than failing the whole resource), and the two tools return guidance instead
of a bare error. When you need a `permission_group_id` or `user_segment_id` without
those rights, read an existing article with `get_article` and reuse the IDs it
reports; omitting `user_segment_id` on create/update keeps the default visibility
(everyone).

## A tool call fails with `Network error on GET https://…`

The request never got an HTTP response — DNS, a refused or reset connection, a
proxy dropping the link. The message names the method and the path so you know
what failed, with credentials stripped: no bearer token, no query string, and an
attachment URL's download token redacted from the path.

The request is tried up to 3 times (so up to two retries) with backoff before you
see this, meaning every attempt failed. What gets retried depends on the method,
because a replay must never duplicate a write:

| | Network failure | `5xx` | `429` |
| --- | --- | --- | --- |
| `GET` | retried | retried | retried |
| `POST`, `PUT`, `DELETE` | retried only if the connection never opened | **not retried** | retried |

So a create, a comment or a delete is never sent twice: a `429` means Zendesk
refused the request, but a `5xx` may have applied it, so it is surfaced rather
than replayed — including on a delete, where a replay would report a misleading
`404` for work that succeeded.

When a response carries `Retry-After` (Zendesk sends it on a `429`, and on a `503`
during maintenance), that delay is used instead of the backoff — unless it exceeds
5 s, in which case the response is surfaced rather than parking the call for that
long. Wait and ask again.

Where each client writes the server's stderr:

| Client | Log location |
|--------|--------------|
| Claude Desktop (macOS) | `~/Library/Logs/Claude/mcp-server-*.log` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\logs\mcp-server-*.log` |
| Claude Code | `claude --debug`, or the session logs |
| Cursor / VS Code / Cline | the extension's MCP output/log panel |

---

← Back to the [README](../README.md).
