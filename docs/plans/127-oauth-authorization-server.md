# Plan — #127 remote OAuth authorization server

> **Temporary.** Working plan for the implementing session. Delete this file in
> the last commit before merge. The durable record is
> [`docs/decisions/oauth-authorization-server.md`](../decisions/oauth-authorization-server.md):
> read it first, every choice below comes from it.

## 0. Before coding

- Re-read #127 live, and check that no other PR is open on it.
- **Prerequisite: #231 (SDK v2 migration) is merged.** It ships separately as a
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
   DCR-only client. The owner will provide the confidential Zendesk client
   (redirect URI `<public-url>/oauth/callback`).
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
- keys and encryption;
- the Keyv adapter, and loading it from `--oauth-store` /
  `--oauth-store-adapter`;
- the trusted-clients policy.

Then:

- `src/transports/http.ts`: mount the AS, rewrite both discovery documents,
  replace passthrough with JWE validation plus an audience check, and keep the
  per-session bearer closure.
- `src/config.ts`: add the new flags and env vars, including the confidential
  client secret, the keys and the store. In HTTP mode, fail fast on a missing
  secret or key.
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
- Filled `toMatchInlineSnapshot` for the metadata documents.
- Mutation gate on changed lines. Keep the coverage ratchet.

## 5. Docs, in the same PR

- `docs/http-deployment.md`: rewrite the Zendesk OAuth setup (one confidential
  client, one redirect URI), the store and volume, the keys, and the trusted
  clients. Drop the "Experimental" banner only once the end-to-end runs pass.
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
