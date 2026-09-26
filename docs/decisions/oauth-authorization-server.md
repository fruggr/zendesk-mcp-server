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
| **Answer** | The server is the OAuth authorization server (AS), built on [`oidc-provider`](https://github.com/panva/node-oidc-provider). Zendesk is the upstream identity provider, through the same public PKCE client the stdio flow already uses. The server issues its own tokens and keeps the Zendesk ones server-side, in a pluggable store (Keyv). The default store is a file. |

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
| Hosted IdP (Auth0, Entra, Stytch, WorkOS, Descope) | Rejected | Constraint 2. |
| Self-hosted Keycloak as the AS | Rejected | It would work: it brokers generic OAuth 2 upstreams since 26.3, has experimental CIMD since 26.6, and hands the Zendesk token back via `POST /realms/{realm}/broker/{alias}/token`. Our server would shrink to a resource server. But it means running Keycloak plus Postgres next to a single small container, which is far too heavy a prerequisite for a niche MCP server. |
| Azure API Management (credential manager as token vault, APIM as the AS) | Rejected | Ties the project to one cloud and to a paid gateway tier. Per-Zendesk-user delegation was not demonstrated: the official sample signs users in through Entra. |
| MCP gateways (Pomerium, agentgateway, MCP Mesh, Obot, ToolHive) | Rejected | Another service for every deployer to run. None was confirmed to combine a generic OAuth upstream like Zendesk with CIMD. |
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
spec. The full survey, with its sources, is at the end of
[the implementation plan](../plans/127-oauth-authorization-server.md#community-survey-sources-behind-the-adr)
while #127 is open.

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
- **Zendesk refreshes are serialised per grant.** Both layers rotate, so two
  concurrent refreshes would spend the same Zendesk refresh token and the second
  would fail. Clients do refresh concurrently: a ChatGPT bug once refreshed on
  every tool call ([forum](https://community.openai.com/t/chatgpt-mcp-connector-refreshes-token-on-every-tool-call-and-doesnt-persist-sessions/1377210)),
  and FastMCP tracks the same race in
  [#4901](https://github.com/PrefectHQ/fastmcp/issues/4901).
  - The lock wraps only the Zendesk refresh. It runs in `extraTokenClaims`,
    when an access token is minted, and only once the Zendesk token is close to
    expiry.
  - Our own `/token` endpoint is **not** serialised. `oidc-provider` revokes the
    whole grant when a consumed refresh token is presented again, so
    serialising our endpoint would turn a benign parallel refresh into a
    logout.
  - `rotateRefreshToken` keeps its default: rotate every refresh for public
    clients. A client that replays an old refresh token therefore signs its
    user out. That is the OAuth 2.1 reuse-detection trade-off, accepted.
- **Refresh tokens are issued without `offline_access`.** The library default
  requires it, and MCP clients do not all ask for it. `expiresWithSession` is
  off, since sessions live in memory and would otherwise take the tokens down
  with them on a restart.
- **Keys** are derived from one configured secret, never generated at startup.
  Otherwise every restart would invalidate every token. See
  [Keys and secrets](#keys-and-secrets).
- **The client's `resource` is never forwarded to Zendesk.**

### Upstream login

- The `oidc-provider` login interaction redirects to Zendesk with the same
  public client the stdio flow uses (`ZENDESK_OAUTH_CLIENT_ID`). The server runs
  PKCE itself and holds the verifier for the length of the login.
  - Setup is one extra redirect URI on that client:
    `<public-url>/oauth/callback`. Zendesk accepts `http://localhost` for local
    runs.
  - No confidential client and no client secret. A secret would only matter if
    a stolen Zendesk refresh token could be used without it, and the store is
    already encrypted.
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
- SSRF protection is built into `oidc-provider`'s fetch: special-use IPs are
  refused at connect time (so DNS rebinding is covered), redirects are not
  followed, and time and size are capped. `allowFetch` adds HTTPS on port 443
  only.
- Some CIMD documents (Claude Code, Zed) list loopback redirect URIs without
  declaring `application_type: native`, so the library matches the port
  exactly and rejects the random port the client picks. A document whose
  redirect URIs are all loopback HTTP is treated as native. The fetch wrapper
  that does it keeps the SSRF-guarded dispatcher.
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
- `file://` is a small in-repo Keyv store: atomic writes (tmp + rename), owner-
  only permissions, and a refusal to start on a corrupt file rather than a
  silent reset. `keyv-file` was rejected for lacking all three.
- Each other adapter is an optional peer dependency, imported only when its
  scheme is asked for. `--oauth-store-adapter <package>` loads any third-party Keyv store.
- **Short-lived models stay in memory** whatever the store: sessions,
  interactions, authorization codes. A restart then costs only an in-flight
  login.
- **Single instance.** Keyv has no atomic get-and-delete, so single use relies
  on an in-process lock per key. Running several replicas needs a store with
  atomic operations, which is out of scope.
- **Reading the store yields nothing usable.**
  - `oidc-provider` uses an opaque token's value as its storage id. Stored as
    is, the file would hand out valid refresh tokens to anyone who can read it.
  - So the adapter keys every record by the SHA-256 of its id (Cloudflare's
    provider stores tokens by hash too).
  - The adapter encrypts **the whole payload** at rest, not only the Zendesk
    tokens.
  - A record read under an older key is re-encrypted with the current one.
    Without that, dropping an old secret would also drop every DCR client,
    since client records are never rewritten otherwise.

### Keys and secrets

`oidc-provider` 9.12.2 has two unsafe defaults, verified in its source:

- **Without `jwks` it falls back to `DEV_KEYSTORE`.** These are development keys
  shipped inside the package, so they are public, and it only logs a warning.
  Anyone could forge our signatures.
- **`cookies.keys` defaults to `[]`.** Session, interaction and consent cookies
  would then go unsigned.

So in HTTP mode the server always has a master secret. It never leaves either
value to the library's defaults: when no secret is supplied, it generates one
and persists it (see [Input](#four-keys-one-secret)).

#### Four keys, one secret

| Key | Purpose | Type |
| --- | --- | --- |
| Signing key (`jwks`) | Anything the AS signs; the public half is served at `/jwks`. Required by `oidc-provider` even though MCP clients do not ask for ID tokens. | Ed25519 |
| Access-token key | Encrypts the JWE access tokens (`dir` + `A256GCM`). Authenticated encryption, no separate signature: `oidc-provider` accepts encrypt-only with a symmetric key. | 256-bit symmetric |
| At-rest key | Encrypts store payloads (grants, refresh tokens, the Zendesk tokens inside them). | 256-bit symmetric |
| Cookie keys (`cookies.keys`) | Keygrip HMAC for session, interaction and consent cookies. | HMAC |

- **All four derive from one master secret** through HKDF (RFC 5869,
  `node:crypto`), with a distinct `info` label per purpose.
  - The Ed25519 key is derived the same way: its private key is, by definition, a
    32-byte random seed.
  - The operator manages **one secret**. It belongs to the MCP server, not to
    Zendesk, which is why its name carries no `ZENDESK_` prefix.
  - The alternative was a JWKS file, a symmetric key and cookie keys supplied
    separately. It is more conventional for the signing key, but it triples what
    has to be provisioned, rotated and kept in sync, for no security gain: all
    the keys fall together anyway if the host is compromised.
- **Input**, in order of precedence:
  1. `OAUTH_MASTER_SECRET` or `--oauth-master-secret-file <path>`: base64, at
     least 32 bytes of entropy. The server rejects a shorter one. Generate it
     with `openssl rand -base64 32`. On Azure Container Apps it is a secret that
     references Key Vault.
  2. Otherwise, the file `oauth-master-secret` in the config directory.
  3. Otherwise, the server generates 32 random bytes and writes them to that
     file (mode 0600), and says so once in its logs. A local run needs no
     setup.
  - With `memory://`, a missing secret is generated in memory only: the store
    does not survive a restart either.
- **Custody.**
  - For a deployment, supply the secret from a secret manager. It should never
    sit on the store's volume. The server warns when an auto-generated secret
    shares a directory with a `file://` store, which is fine locally.
  - It is never logged, and never echoed in errors (ASCII-only messages on auth
    paths still apply).

#### Rotation

- The secret accepts a **comma-separated list**, newest first.
  - The first entry signs and encrypts.
  - Every entry verifies and decrypts.
  - Each derived key carries a `kid` derived from it, so the right key is picked
    without trial decryption.
  - Keygrip takes the cookie keys as a list natively.
- **Procedure.**
  1. Prepend the new secret.
  2. Redeploy.
  3. Drop the old secret after the longest refresh-token lifetime has passed
     (≤ 90 days, Zendesk's cap).
  
  Every record rewritten in the meantime is re-encrypted with the current key.
  Records still under the old key when it is dropped fail to decrypt, and those
  users sign in again.
- **Emergency rotation** (secret exposed): replace the list outright, without
  keeping the old secret.
  - Every token becomes invalid, every user signs in again, and the store is
    purged.
  - The Zendesk tokens the store held stay valid at Zendesk until they expire
    or are revoked there. There is no client secret to regenerate, since the
    client is public, so revoke them at Zendesk if the store may have leaked
    too.

#### Loss

- **A lost secret means the same as an emergency rotation.** Tokens and store
  contents become unreadable, users sign in again, and the store is purged. There
  is no recovery path by design.
- **Losing the auto-generated file** is the same event. It is why a deployment
  supplies its secret explicitly.

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
- **One master secret is a single point of failure.** Exposing it together with
  the store exposes the users' Zendesk refresh tokens, hence the separate
  volumes and the emergency rotation above.
- **Two layers of grants** (ours and Zendesk's). Revoking at Zendesk still wins:
  the next Zendesk call fails, the server answers 401, and the client re-runs
  authorization.

## What would reverse this

- **Zendesk ships DCR or CIMD and RFC 8414.** Then the server can go back to
  being a pure resource server. It still needs audience-bound tokens, which a
  Zendesk token is not.
- **`oidc-provider` stops being maintained**, or drops CIMD. Then re-evaluate
  `@better-auth/mcp`.
- **Deployers ask to bring their own AS** (Keycloak, a gateway). Then add an
  opt-in resource-server mode that validates a configured issuer's JWT and
  fetches the Zendesk token from a broker. The built-in AS stays the default.
- **A supported stateless refresh-token format lands** in `oidc-provider`. Then
  the store could go.
