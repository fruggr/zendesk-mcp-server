# Remote OAuth: the server becomes its own authorization server, on `oidc-provider`

> **Build documentation, not user documentation.** This records why the HTTP
> transport stops advertising Zendesk as the authorization server and runs one
> itself. Deployment steps belong in
> [`docs/http-deployment.md`](../http-deployment.md).

| | |
| --- | --- |
| **Status** | Decided, not yet applied |
| **Date** | 2026-09-24 |
| **Applies** | [#127](https://github.com/fruggr/zendesk-mcp-server/issues/127) — ships as a major release (3.0), after the SDK v2 migration ([#231](https://github.com/fruggr/zendesk-mcp-server/issues/231)) |
| **Question** | How does a remote MCP client (claude.ai, ChatGPT, …) sign a user in when Zendesk offers neither discovery nor client registration? |
| **Answer** | The server is the OAuth authorization server (AS), built on [`oidc-provider`](https://github.com/panva/node-oidc-provider). Zendesk is the upstream identity provider, through one confidential client. The server issues its own tokens and keeps the Zendesk ones server-side, in a pluggable store (Keyv). The default store is a file. |

## Why the current design cannot stay

- **Web clients cannot connect.** They resolve the AS from the protected-resource
  metadata, then register through DCR (RFC 7591) or a Client ID Metadata Document
  (CIMD). Zendesk has neither, nor RFC 8414 discovery. A Zendesk OAuth client is
  created by hand, with pre-registered redirect URIs, one per MCP client.
- **It is token passthrough.** The server accepts a Zendesk bearer as is. The
  MCP spec 2026-07-28 forbids it: servers "MUST validate that access tokens were
  issued specifically for them" and "MUST NOT accept or transit any other
  tokens" ([authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)).
- **The SDK no longer helps.** SDK v2 moved `mcpAuthRouter` and
  `ProxyOAuthServerProvider` to `@modelcontextprotocol/server-legacy/auth`,
  described as a "deprecated, frozen v1 copy". Its guidance is to migrate the AS
  to a dedicated library
  ([upgrade guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html)).

## Constraints the decision had to meet

1. **No hand-written OAuth protocol.** The standard is tracked by upgrading a
   library, not by recoding. The owner recently replaced 8,000 lines of custom
   OAuth with a few hundred lines of `oidc-provider`.
2. **Independent.** No external IdP (Auth0, Keycloak, Entra) in the AS role.
3. **A redeploy logs nobody out.** Deploys are frequent.
4. **Re-login no more often than the Zendesk refresh token forces it.** Zendesk
   caps an access token at 48 h (5 min minimum, 30 min default), and a refresh
   token at 7–90 days (30 days default). Refresh rotates: the previous pair
   becomes invalid
   ([Zendesk](https://developer.zendesk.com/documentation/api-basics/authentication/refresh-token/)).
   A 48 h re-login was judged too frequent.
5. **This is a library, not a hosted service.** Anyone deploys it anywhere, so
   storage has to be pluggable and chosen by configuration.

## Options considered

| Option | Verdict | Why |
| --- | --- | --- |
| **`oidc-provider` + pluggable store** | **Chosen** | Certified library, and the pattern the community converged on (below). Its one cost, a store, is inevitable for refresh. |
| `oidc-provider` with no refresh tokens, memory only | Rejected | Stateless in practice, but forces a re-login every ≤48 h (constraint 4). |
| Stateless AS written in-house (JWE-wrapped Zendesk code and refresh token) | Rejected | Zendesk would enforce single use and rotation. But every endpoint, DCR, CIMD, consent and metadata would be ours (constraint 1). No reference MCP implementation hands a refresh token to the client. |
| Relay in the style of [softeria/ms-365-mcp-server](https://github.com/softeria/ms-365-mcp-server) | Rejected | Zero storage only by cutting what the spec requires. Its `/register` returns `mcp-client-${Date.now()}` and stores nothing. `/token` returns the upstream token and refresh token to the client (passthrough). Read in its source. |
| `@modelcontextprotocol/server-legacy/auth` | Rejected | Frozen and deprecated. |
| FastMCP (TypeScript, `punkpeye/fastmcp`) | Rejected | It is its own, uncertified OAuth proxy. It ships only an in-memory `TokenStorage` and still depends on SDK v1. The project already left it once, over an unfixed high-severity vulnerability. |
| `@cloudflare/workers-oauth-provider` | Rejected | Bound to Cloudflare Workers KV. |
| External IdP (Keycloak, Auth0, Entra) | Rejected | Constraint 2. |
| `@better-auth/mcp` | Not retained | It targets spec 2026-07-28 and SDK v2, but brings a full database-backed auth framework. `oidc-provider` is certified. |

### Where the community landed

Most proxy servers issue their own tokens and keep the upstream token
server-side. Examples:

- Sentry keeps it in encrypted props in Workers KV;
- FastMCP (Python) uses a key-value store;
- the Azure APIM sample uses the APIM cache;
- [`tigrisdata/mcp-oidc-provider`](https://github.com/tigrisdata/mcp-oidc-provider)
  pairs `oidc-provider` with Keyv.

Passthrough (softeria, mcp-use's `oauthProxy`) is the minority, and it breaks the
spec. The full survey is kept in the PR that applied this record.

## The design

### Tokens

- **Access token**: a short-lived, encrypted JWT (JWE). Its audience is the
  canonical `/mcp` resource, and it carries the Zendesk access token.
  `oidc-provider` does not persist JWT-format access tokens: `save()` writes
  nothing for them.
- **Refresh token**: opaque, persisted. The grant holds the Zendesk refresh
  token, encrypted at rest with `jose`. It cannot be stateless. `oidc-provider`
  generates the opaque value (a random `nanoid`) before the adapter sees it, and
  panva declines pluggable token formats
  ([discussion #1256](https://github.com/panva/node-oidc-provider/discussions/1256)).
- **Refreshes are serialised per grant.** Both layers rotate, so two
  concurrent refreshes spend the same Zendesk refresh token and the second one
  fails. Clients do refresh concurrently: a ChatGPT bug once refreshed on every
  tool call ([forum](https://community.openai.com/t/chatgpt-mcp-connector-refreshes-token-on-every-tool-call-and-doesnt-persist-sessions/1377210)),
  and FastMCP tracks the same race in
  [#4901](https://github.com/PrefectHQ/fastmcp/issues/4901). `rotateRefreshToken`
  is set with that in mind.
- **Keys** come from configuration, not generation. Otherwise every restart
  would invalidate every token. The keys are the JWKS, the JWE key and the
  at-rest key.
- **The client's `resource` is never forwarded to Zendesk.**

### Upstream login

- The `oidc-provider` login interaction redirects to Zendesk with the one
  confidential client, and one redirect URI: `<public-url>/oauth/callback`.
- The account is resolved with `/api/v2/users/me`, since Zendesk is not OIDC.
- The Zendesk access token is requested with its maximum lifetime (48 h). The
  refresh token is requested with a lifetime that fits constraint 4.

### Client registration

- **CIMD first.** claude.ai and ChatGPT prefer it when the AS advertises it
  ([Claude](https://claude.com/docs/connectors/building/authentication),
  [OpenAI](https://developers.openai.com/plugins/build/auth)).
- **DCR as the fallback** for clients without CIMD. The spec deprecates DCR but
  keeps it for compatibility.
- CIMD is experimental in `oidc-provider` 9, and draft updates ship in minor
  releases. The dependency is therefore pinned with `~`.
- The `allowFetch` hook guards against SSRF: HTTPS only, and no private or
  loopback addresses.
- `offline_access` goes in the AS metadata, because ChatGPT needs it to refresh.
  It stays out of the protected-resource metadata, where the spec says it SHOULD
  NOT appear.

### Consent

This is a deliberate deviation from the spec's MUST.

The spec requires a per-client consent screen on proxy servers. It defends
against a confused deputy: the upstream remembers consent for the static client
(**Zendesk does, for weeks**), so an attacker who registers a client can have the
code sent to their own redirect URI.

Showing it to everyone would put two screens in a row that say the same thing.
Instead:

- **A trusted CIMD client with non-loopback HTTPS redirect URIs skips it.**
  - Trust is an exact `client_id` match against a configurable allowlist.
  - It is never a domain match: `claude.ai` and `chatgpt.com` also host loopback
    clients (Claude Code, Codex).
  - The requested `redirect_uri` must be HTTPS, non-loopback, and listed in the
    fetched document. The redirect URIs come from a document served on the
    client's own domain, so the code cannot be diverted.
  - The built-in seed is claude.ai and ChatGPT. They are the only mainstream CIMD
    clients whose redirects are HTTPS today (fetched 2026-09-24).
  - The skip goes through `loadExistingGrant`, which `oidc-provider` documents for
    pre-agreed consent.
  - The remembered consent is tied to a hash of the client's `redirect_uris`.
- **Everything else sees the MCP screen once per client**: DCR, unknown CIMD,
  and loopback redirect URIs. Loopback is the case the spec flags as
  impersonable. The screen names the client, the scopes and the redirect URI, per
  the spec's UI requirements.

### Storage

- **Keyv** is the abstraction. `--oauth-store <uri>` picks the backend by URL
  scheme: `file://` (the default), `redis://`, `postgres://`, `sqlite://`,
  `memory://` (dev and tests).
- Each adapter is an optional peer dependency, imported only when its scheme is
  asked for. `--oauth-store-adapter <package>` loads any third-party Keyv store.
- **Short-lived models stay in memory** whatever the store: sessions,
  interactions, authorization codes. A restart then costs only an in-flight
  login.
- **Single instance.** Keyv has no atomic get-and-delete, so single use relies
  on an in-process lock per key. Running several replicas needs a store with
  atomic operations, which is out of scope.

### Scope of the change

- The current passthrough mode is **removed**, which makes this a breaking change
  (3.0).
- stdio is untouched: it keeps the browser PKCE flow in `token-store.ts`.
- The end-user `requests` namespace is unaffected. It uses the same bearer path,
  and the bearer now resolves through the JWE.

## Costs accepted

- **Storage becomes part of the deployment.** A file on a mounted volume is
  enough (e.g. Azure Files on Container Apps).
- **Multi-instance deployments are unsupported** until an atomic store is wired
  in.
- **A security surface we now own.** Token custody, key management and the
  consent policy.
- **Two layers of grants** (ours and Zendesk's). Revoking at Zendesk still wins:
  the next Zendesk call fails, the server answers 401, and the client re-runs
  authorization.

## What would reverse this

- **Zendesk ships DCR or CIMD and RFC 8414.** Then the server can go back to
  being a pure resource server. It still needs audience-bound tokens, which a
  Zendesk token is not.
- **`oidc-provider` stops being maintained**, or drops CIMD. Then re-evaluate
  `@better-auth/mcp`.
- **A supported stateless refresh-token format lands** in `oidc-provider`. Then
  the store could go.
