# Plan — #127 remote OAuth authorization server

> **Temporary.** Working plan for the implementing session. Delete this file in
> the last commit before merge. The durable record is
> [`docs/decisions/oauth-authorization-server.md`](../decisions/oauth-authorization-server.md):
> read it first, every choice below comes from it.

## 0. Before coding

- Re-read #127 live, and check that no other PR is open on it.
- Split out the SDK v2 migration. Open an issue for it, then a branch
  `<n>-mcp-sdk-v2` and a separate PR that **lands first**. It is a mechanical
  upgrade with no behaviour change:
  - run `npx @modelcontextprotocol/codemod@latest v1-to-v2 .` at the repo root;
  - `StreamableHTTPServerTransport` becomes `NodeStreamableHTTPServerTransport`
    (`@modelcontextprotocol/node`);
  - stdio moves to `@modelcontextprotocol/server/stdio`.
  - Check against the repo: Zod ≥ 4.2 and Node ≥ 20 are already met.
- Rebase this branch on it.

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

No canonical public list was found. Delegate the research to an agent. Seed only
entries verified at the source:

- claude.ai: `https://claude.ai/oauth/mcp-oauth-client-metadata`, secondary
  source.
- Claude Code: `https://claude.ai/oauth/claude-code-client-metadata`. It uses
  loopback redirects, so the consent screen stays on for it.
- ChatGPT: `https://chatgpt.com/oauth/client.json`, secondary source.

The list is configurable (e.g. `--oauth-trusted-client <url>`, repeatable). A
skip also requires non-loopback HTTPS `redirect_uris` (ADR, Consent).

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
