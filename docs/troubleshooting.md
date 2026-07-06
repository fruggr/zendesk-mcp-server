# Troubleshooting — Zendesk MCP Server

Common issues running the [Zendesk MCP Server](../README.md) and how to diagnose
them. See also [Configuration](configuration.md) for the flags and environment
variables referenced below.

## The browser doesn't open during OAuth login

The OAuth flow opens your default browser on the first tool call. The first call
fails fast with a message that includes the authorize URL, so even if the
browser can't open (common in sandboxed or remote desktop environments) you can
open that URL manually — it's also printed to the server's stderr. Sign in, then
retry the request.

To collect diagnostics, restart with `LOG_LEVEL=debug`. The server then emits
structured logs through **two channels**, so they're reachable on any MCP client:

- **stderr** — captured to a log file by every mainstream client.
- **MCP logging notifications** (`notifications/message`) — surfaced by clients
  that support the `logging` capability.

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

The OAuth token is persisted to an owner-only file in your OS config dir and
reused across restarts, so this shouldn't happen. If it does, check that the file
is writable (`ZENDESK_TOKEN_FILE` to relocate it) and look for
`token_persist_failed` in the logs.

Where each client writes the server's stderr:

| Client | Log location |
|--------|--------------|
| Claude Desktop (macOS) | `~/Library/Logs/Claude/mcp-server-*.log` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\logs\mcp-server-*.log` |
| Claude Code | `claude --debug`, or the session logs |
| Cursor / VS Code / Cline | the extension's MCP output/log panel |

---

← Back to the [README](../README.md).
