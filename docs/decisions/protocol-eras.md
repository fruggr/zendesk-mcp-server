# Protocol eras: serving MCP 2025 and 2026-07-28 side by side

> **Build documentation, not user documentation.** This records why the
> transports serve both protocol eras the way they do. Operator-facing behaviour
> is described in [`docs/http-deployment.md`](../http-deployment.md#protocol-revisions).

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-10-17 |
| **Applied in** | [#394](https://github.com/fruggr/zendesk-mcp-server/pull/394) ([#392](https://github.com/fruggr/zendesk-mcp-server/issues/392)) |
| **Question** | How do both transports serve 2026-07-28 without changing anything for 2025 clients, on SDK `@modelcontextprotocol/server` 2.x? |
| **Answer** | The SDK's own era-aware entries (`serveStdio`, `createMcpHandler`), with HTTP 2025 traffic kept on our sessionful wiring, and per-grant state for what a 2026 request cannot hold. |

## What changed in 2026-07-28

No session: every request carries its protocol version and the client's
capabilities; `server/discover` replaces `initialize`; change notifications
travel on a `subscriptions/listen` stream; asking the client for input is a
multi-round-trip `input_required` result instead of a server-to-client request.
`server.connect(transport)` only negotiates the 2025 revisions.

## stdio

`serveStdio` picks the era from the client's opening exchange and pins one
server from our factory per connection. It takes our own `StdioServerTransport`,
so `STDIO_MAX_MESSAGE_BYTES` still bounds a message. Nothing else is specific:
one user, one process.

## HTTP: hybrid routing

`createMcpHandler`'s own 2025 fallback is stateless: it answers GET and DELETE
with 405, so it would drop sessions, the idle sweeper, the session ↔ user binding
and 2025 `resources/subscribe` notifications. The SDK documents the alternative
used here: `isLegacyRequest` in front of a `legacy: 'reject'` handler, 2025
traffic routed to the existing wiring. Authentication (the audience-bound JWE on
every request), the body cap and CORS stay in front of both.

## HTTP: one entry per grant

A 2026 request gets a fresh server, so whatever must outlive it lives in an
entry per **grant**:

- **The Help Center caches** (brand list, topology, promoted pre-listing). They
  depend on the caller's Zendesk role (an agent lists only the brands they
  belong to unless they hold `assign_tickets_to_any_brand`), so a cache shared by
  all users would be wrong for some and too permissive for others.
- **The listen bus.** `createMcpHandler`'s bus filters on notification type and
  URI, not on user. One handler per grant isolates them using public API only:
  the same calls as a single handler, several instances. Partitioning one bus by
  user was rejected: it would depend on when the SDK calls `subscribe()`
  internally.

Keyed by grant, not user: a grant carries one Zendesk token, so an entry always
fetches with the token of the grant using it, and a Zendesk 401 closes that
grant's entry only (once the request that hit it has answered).

## Listen streams and notifications

A listen stream is authenticated when it opens, like a 2025 session's GET
stream. It closes with its grant: 30 minutes after the grant's last request, the
2025 session rule, or once the grant's requests in flight have answered when
Zendesk rejects its token on one of them (closing earlier would abort those
answers). A grant ended elsewhere (a 2025 session, a revocation at the
authorization server) refuses new requests at once, but its open streams wait
for the idle timeout: closing them would need a hook from the authorization
server into the transport, not built yet. Cutting it at
token expiry was rejected: the SDK client does not listen again on its own, so
clients would lose notifications silently every hour.

**Rule: a notification carries no sensitive data.** The URI is the whole
payload; no content, no personal data, nothing confidential in the URI.

## `requestState`

`requestState` round-trips through the client and comes back as attacker-
controlled input; the spec requires integrity protection and binding to the
user, and the SDK verifies nothing by default. Every server verifies it with the
SDK's HMAC codec (`src/utils/request-state.ts`), bound to the method and the
principal. HTTP signs with a key derived from the master secret
(`zendesk-mcp/request-state/v1`) and binds to the grant; stdio draws a random
key per process. **Rule: handlers mint state only through the codec.**

## No MCP logging channel

The server `logging` capability and `sendLoggingMessage` are deprecated as of
2026-07-28 (SEP-2577); the SDK points to stderr or OpenTelemetry. The logger had
a single MCP sink, re-pointed by every server it built: on HTTP, a diagnostic
raised for one user could reach whichever session opened last. On stdio it only
duplicated stderr. The channel is gone on every transport and era: same code
everywhere, so that class of leak cannot come back.

## Costs and limits

- A 2026 HTTP request builds a server: about 4 ms (`--mode all`) to 7.5 ms
  (`--mode namespace`) of CPU, measured. Fine at today's scale.
- The SDK consumes the listen filter, so the transports read
  `resourceSubscriptions` off the wire themselves (`utils/listen-feed.ts`): a
  listen request opens a stream, its cancellation or any response carrying its
  id ends it. That ties pollers to the wire shape of `subscriptions/listen`.
  On HTTP the grant owns the poller; a per-request server only advertises
  `resources.subscribe`, which the SDK needs to honour the filter's URIs.
- Still one HTTP instance: the per-grant entries live in this process.

## SDK churn

SDK 2.x shipped four minor versions between 2026-07-27 and 2026-10-05, and
removed options in between. Mitigation: the smallest public surface
(`serveStdio`, `createMcpHandler`, `isLegacyRequest`, `toNodeHandler`,
`toWebRequest`, `createRequestStateCodec`), pinned versions, and both eras under
the integration suite so every dependency bump is checked.
