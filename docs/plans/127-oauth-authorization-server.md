# Plan — #127 remote OAuth authorization server

> **Temporary.** This is the working plan for the session that implements
> [#127](https://github.com/fruggr/zendesk-mcp-server/issues/127). That session
> deletes this file in the last commit of its PR. The durable record is
> [`docs/decisions/oauth-authorization-server.md`](../decisions/oauth-authorization-server.md):
> read it first, every choice below comes from it.

## 0. Before coding

- Re-read #127 live, and check that no other PR is open on it.
- **Prerequisite: #231 (SDK v2 migration) is merged** (done, #315). It ships separately as a
  2.x minor, with no behaviour change. It swaps the HTTP transport for
  `NodeStreamableHTTPServerTransport` and keeps everything else. There is no
  beta channel.
- Merge `main` into this branch once #231 has landed.
- **Nobody uses the HTTP transport today.** Rewrite it freely: no migration
  path, no compatibility shim for the passthrough mode. The 3.0 release notes
  just state that it was removed. Adopting the v2 stateless handler
  (`createMcpHandler`) is allowed if it simplifies things.

## 1. Spike (throwaway, findings go into this file)

Each check answers a question the ADR assumes. Record the answer here before
building on it.

### Results (2026-09-26, `oidc-provider` 9.12.2, Node 20.20 and 22.22)

The spike drove a scripted client against a fake Zendesk (single-use,
rotating refresh tokens). Items 1–8 pass, 9 is local-only (see §6), 10 is
observed in validation.

| # | Answer |
| --- | --- |
| 1 | `provider.callback()` mounts in `node:http` next to `/mcp`, no Express. The RFC 8414 path `/.well-known/oauth-authorization-server` is served natively. |
| 2 | Works. The interaction cookie is scoped to `/interaction/<uid>`, so `/oauth/callback` 302s to `/interaction/<uid>/callback` (state = uid). The consent prompt opens a **new** interaction uid: Zendesk tokens pending between login and consent are keyed by `accountId|clientId`. |
| 3 | JWE via `resourceIndicators.getResourceServerInfo` (`jwt.encrypt` only, `dir` + `A256GCM`) with `extraTokenClaims`. The adapter sees no `AccessToken` write. The bearer check decrypts by `kid` and checks `iss`, `aud`, `exp`; a raw Zendesk bearer gets a 401. |
| 4 | The `Grant` payload is closed (`IN_PAYLOAD`), so Zendesk tokens live in a separate `ZendeskTokens` record keyed by `grantId`. The Zendesk refresh runs in `extraTokenClaims` (documented hook), so no `registerGrantType`. |
| 5 | Lock on the Zendesk refresh only: 5 parallel refreshes → 1 Zendesk refresh, 0 failures. Our `/token` must **not** be serialised: two parallel refreshes with the same RT both succeed (the grant forks), while a sequential replay of a consumed RT revokes the whole grant. `rotateRefreshToken` keeps its default (rotate every time for `none` clients). |
| 6 | Codes and RTs go through `find` then `consume`. The race is benign (see 5); no adapter lock is needed. |
| 7 | `ack: 'draft-02'`, built-in cache (`cacheDuration` 30 s–24 h). SSRF protection is built into the library fetch (special-use IPs refused at connect time, `redirect: manual`, 2.5 s timeout, 5 KB body cap): `allowFetch` only enforces HTTPS on 443. Trusted skip works by finishing the login with `consent.grantId`. Claude Code and Zed documents lack `application_type: native`, so a random loopback port is rejected; inferring `native` when every redirect URI is loopback HTTP fixes it. |
| 8 | Keyv adapter with `keyv-file`: SHA-256 keys, whole-payload JWE, grant index for `revokeByGrantId`. The store file holds no raw token, no Zendesk token, no account id. Restart with the same secret keeps refresh working. Rotation `NEW,OLD` accepts old tokens; `NEW` alone rejects them **and drops DCR clients** (never rewritten), hence re-encryption on read. The implementation replaces `keyv-file` with an in-repo file store: `keyv-file` writes with a plain `writeFile` (a crash can truncate it) and its loader then silently starts empty, logging everyone out. |
| 9 | Not reachable from a cloud container. Local E2E covers Claude Code and a DCR client; claude.ai and ChatGPT come later on a deployed instance. `private_key_jwt` (ChatGPT-style document, RS256, `jwks_uri`) passes against a mocked document. |
| 10 | To observe in validation. Zendesk browser sessions (8 h inactivity, 12 h max for team members on the fruggr account) are distinct from OAuth token lifetimes; whether they affect the tokens is unknown. |

Configuration the library needs beyond the ADR:

- `clientDefaults.id_token_signed_response_alg: 'EdDSA'`, since the only
  signing key is Ed25519. Without it DCR fails.
- `issueRefreshToken` checks only `client.grantTypeAllowed('refresh_token')`.
  The default also requires `offline_access`.
- `expiresWithSession: () => false`, or tokens die with the in-memory session.
- `read` and `write` are listed in `scopes` (for the metadata) and are resource
  scopes. The grant must carry both `addOIDCScope` and `addResourceScope`, or
  consent loops.
- `provider.proxy = true` behind a TLS-terminating proxy.

1. `oidc-provider` 9.x mounted in the `node:http` server (`provider.callback()`)
   next to `/mcp`, with no Express.
2. The login interaction redirects to Zendesk, handles the callback, exchanges
   the code and resolves the account via `/api/v2/users/me`.
3. JWT-format access token, encrypted (`resourceServer.jwt.encrypt`), carrying
   the Zendesk access token via `extraTokenClaims`. Confirm nothing is written
   to the adapter for it, and that the `/mcp` bearer check can decrypt it.
4. The grant stores the Zendesk refresh token, encrypted. Our `refresh_token`
   grant refreshes Zendesk when needed. Check whether that runs through a
   documented hook, or whether it needs `registerGrantType`, which relies on
   helpers outside semver (see the ADR).
5. Concurrent refreshes: a per-grant lock, and the `rotateRefreshToken` setting.
   Reproduce two parallel refreshes in a test.
6. How `oidc-provider` consumes codes and refresh tokens through the adapter
   (`consume`), and whether an in-process lock per key is enough on one
   instance.
7. CIMD (`features.clientIdMetadataDocument`, experimental): the exact `ack`
   value, the `allowFetch` SSRF guard, and a trusted-client skip via
   `loadExistingGrant`.
8. Keyv adapter over `oidc-provider`'s adapter interface, with `file://`
   (`keyv-file`) as the default.
9. End to end on claude.ai (CIMD), ChatGPT (CIMD with `offline_access`) and one
   DCR-only client. The existing public Zendesk App is reused; add the redirect
   URI `<public-url>/oauth/callback` to it.
10. Zendesk token lifetimes: request `expires_in` at 48 h, and choose
    `refresh_token_expires_in` within 7–90 days.

## 2. Trusted CIMD clients (consent skip list)

**No public, maintained registry of MCP CIMD `client_id`s exists.** We checked
the Zuplo compatibility matrix, FastMCP's `CIMDTrustPolicy` example,
workers-oauth-provider, better-auth, Keycloak, Clerk and Authlete. They offer
mechanisms or examples, not a reusable list. So we keep our own short,
versioned allowlist in the repo.

### Seed list

Documents fetched with `curl -H 'Accept: application/json'` on 2026-09-24. Only
the first two are skip-eligible.

| Client | `client_id` (exact) | `redirect_uris` (as fetched) | Auth method | Verdict |
| --- | --- | --- | --- | --- |
| claude.ai, Claude Desktop, mobile, Cowork | `https://claude.ai/oauth/mcp-oauth-client-metadata` | `https://claude.ai/api/mcp/auth_callback` | `none` | **skip** |
| ChatGPT (web, desktop), stable URL | `https://chatgpt.com/oauth/client.json` | `https://chatgpt.com/connector_platform_oauth_redirect` | `private_key_jwt` (also `none`) | **skip** |
| Claude Code | `https://claude.ai/oauth/claude-code-client-metadata` | `http://localhost/callback`, `http://127.0.0.1/callback` | `none` | consent |
| Codex | `https://chatgpt.com/oauth/codex/client.json` | `http://127.0.0.1/callback`, `http://localhost/callback` | `none` | consent |
| VS Code | `https://vscode.dev/oauth/client-metadata.json` | `http://127.0.0.1:33418/`, `https://vscode.dev/redirect` | `none` | consent (desktop uses loopback) |
| Zed | `https://zed.dev/oauth/client-metadata.json` | `http://127.0.0.1/callback` | `none` | consent |
| OpenCode | `https://opencode.ai/oauth/opencode/client.json` | `http://127.0.0.1/callback`, `http://localhost/callback` | `none` | consent |

These clients publish no CIMD (they use DCR, a static client, or were not
found): Cursor, Copilot Studio, Gemini CLI, Mistral Le Chat, Windsurf, JetBrains,
Perplexity, Grok, Cline, Continue, LibreChat, n8n, Zapier, Make. Goose supports
CIMD, but its URL was not found.

### Matching rule, checked on every authorization request

1. The `client_id` is in the allowlist, as an **exact string**. Never match on
   the domain: `claude.ai` and `chatgpt.com` also host loopback clients (Claude
   Code, Codex).
2. The fetched document's `client_id` equals its URL.
3. The requested `redirect_uri` is an exact member of the document's
   `redirect_uris`.
4. That `redirect_uri` is `https`, not loopback (`localhost`, `127.0.0.0/8`,
   `[::1]`), and not a custom scheme.
5. All four pass: skip consent. Otherwise, show the MCP screen with the redirect
   hostname displayed.

The remembered consent is tied to a hash of the `redirect_uris`. It is asked for
again when the document changes.

### Requirements this puts on the AS (spike items)

- **RFC 9207 `iss` in authorization responses.** ChatGPT uses its stable URL
  only if the AS advertises `authorization_response_iss_parameter_supported:
  true`. Without it, ChatGPT switches to per-connector URLs
  (`https://chatgpt.com/oauth/{callback_id}/client.json`) that cannot be
  enumerated. Allowlist only the stable URL. Do not add a pattern rule.
- **`private_key_jwt`.** ChatGPT prefers it, with `jwks_uri`
  `https://chatgpt.com/oauth/jwks.json`. Accept it, or at least negotiate `none`
  from its `token_endpoint_auth_methods_supported`. Otherwise ChatGPT is rejected
  (django-oauth-toolkit #1857).
- **The `jwt-bearer` grant** that claude.ai declares must be ignored, not
  rejected.
- **Document fetch.** Fetch only allowlisted `client_id`s, plus unknown CIMD
  clients, which always get the consent screen.
  - HTTPS on port 443, no redirects, DNS resolved once and the IP pinned.
  - Private, loopback and link-local ranges refused.
  - Size capped at ~64 KB, 5 s timeout.
  - `jwks_uri` follows the same rules.
- **Cache.** Honour the HTTP cache headers, capped at 24 h. Keep the last valid
  copy for an allowlisted client if a fetch fails, and cache failures for 60 s.
  Some documents return 403 to cloud egress IPs:
  - `claude-code-client-metadata` (anthropics/claude-code #84263);
  - Codex (cloudflare/workers-oauth-provider #333).
  
  Pinned copies, with an alert when they diverge from the live document, cover
  that case.
- **Config.**
  - `--oauth-trusted-client <url>` (repeatable) adds entries.
  - `--no-default-trusted-clients` drops the built-in seed.
- **Deferred to #316**: the last-good copy, the 60 s failure cache, pinned
  copies and the upkeep test below. The first version relies on the library's
  cache.

### Upkeep

- An integration test (live, not in CI) re-fetches each allowlisted document and
  fails when its `redirect_uris` change.
- Review the list quarterly. The Zuplo matrix signals new CIMD clients, and more
  will come as the spec deprecates DCR.

## 3. Implementation (TDD, functional style)

Suggested modules:

- `src/auth/server/`: provider configuration;
- the Zendesk upstream interaction;
- the consent view;
- keys and encryption: the HKDF derivation of the four keys, the `kid`s, the
  rotation list, and the refusal to start without a secret (ADR, Keys and
  secrets);
- the Keyv adapter, with SHA-256-hashed record ids and encrypted payloads,
  and loading it from `--oauth-store` /
  `--oauth-store-adapter`;
- the trusted-clients policy.

Then:

- `src/transports/http.ts`: mount the AS, rewrite both discovery documents,
  replace passthrough with JWE validation plus an audience check, and keep the
  per-session bearer closure.
- `src/config.ts`: add the new flags and env vars. The Zendesk client stays
  the shared `ZENDESK_OAUTH_CLIENT_ID` (public, PKCE); there is no client
  secret. The master secret is `OAUTH_MASTER_SECRET` /
  `--oauth-master-secret-file`, auto-generated and persisted when absent (ADR,
  Keys and secrets). Fail fast on a supplied secret under 32 bytes.
- ASCII-only messages on auth paths (`WWW-Authenticate`), per `AGENTS.md`.

## 4. Tests

- MSW for every Zendesk call: the token exchange, the refresh with rotation, and
  `users/me`.
- `tests/integration/`:
  - the full DCR flow and the CIMD flow (with a mocked metadata document);
  - consent skip versus screen;
  - the audience check;
  - a restart with a `file://` store keeps refresh working;
  - concurrent refreshes.
- Keys:
  - HTTP mode refuses to start without a secret, or with one under 32 bytes;
  - `DEV_KEYSTORE` and empty `cookies.keys` are never reached;
  - a token issued under the old secret still validates after a new secret is
    prepended, and fails once the old one is dropped;
  - the store file holds no raw token id and no plaintext payload.
- Filled `toMatchInlineSnapshot` for the metadata documents.
- Mutation gate on changed lines. Keep the coverage ratchet.

## 5. Docs, in the same PR

- `docs/http-deployment.md`: rewrite the Zendesk OAuth setup (the same App as
  stdio, plus one redirect URI), the store and volume, the master secret, and
  the trusted clients. Drop the "Experimental" banner only once the end-to-end runs pass.
- `docs/configuration.md`: the new flags.
- `README.md`: fix the remote quick start. Keep the why/what only.
- `docs/troubleshooting.md`: 401 and re-auth, store permissions, lost keys.
- ADR: set **Status** to "Decided and applied", and link the PR.

## 6. Validation and release

- Write the functional validation plan with the `functional-validation-plan`
  skill, in the PR description, for an independent validator.
- The commit that lands the change carries a `BREAKING CHANGE:` footer, so that
  semantic-release publishes 3.0. Never hand-bump the version.
- The PR description keeps `Closes #127`.

## Community survey (sources behind the ADR)

- **Passthrough is the minority:**
  - softeria (read in its source);
  - mcp-use `oauthProxy`: "passes upstream tokens through without minting its
    own".
- **Own tokens, with the upstream token kept server-side:**
  - [Sentry](https://github.com/getsentry/sentry-mcp) (encrypted props in
    Workers KV);
  - [FastMCP Python OAuthProxy](https://gofastmcp.com/servers/auth/oauth-proxy)
    (key-value store);
  - [Azure APIM sample](https://github.com/azure-samples/remote-mcp-apim-functions-python)
    (APIM cache);
  - [`tigrisdata/mcp-oidc-provider`](https://github.com/tigrisdata/mcp-oidc-provider)
    (`oidc-provider` + Keyv; it notes that keys generated at startup invalidate
    tokens on restart).
- **The same pattern, cited as the reference:**
  [csharp-sdk #1446](https://github.com/modelcontextprotocol/csharp-sdk/issues/1446)
  ("token factory pattern", "encrypt and store upstream tokens server-side").
- **No stateless refresh-token mechanism** exists in `oidc-provider`, and panva
  declines pluggable token formats
  ([#1256](https://github.com/panva/node-oidc-provider/discussions/1256)).
- **RFC 7591 A.5.2** allows a stateless DCR `client_id`. No production MCP
  server was found using it, and CIMD makes it marginal.
