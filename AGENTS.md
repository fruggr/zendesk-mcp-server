# Development Guide

## Prerequisites

- Node.js >= 20
- pnpm (package manager)
- A Zendesk instance with admin access

## Setup

```bash
pnpm install
```

## Architecture

```
src/
├── index.ts              # Entry point, CLI args, transport + auth dispatch
├── server.ts             # FastMCP setup, tool registration per mode, OAuth discovery
├── config.ts             # CLI + env vars parsing (Zod validated, transport-aware)
├── constants.ts          # Zendesk API URLs, OAuth URLs, limits
├── types.ts              # Zendesk API response interfaces
├── auth/
│   ├── browser-oauth.ts  # OAuth 2.1 PKCE browser flow for stdio (authorize/callback/token)
│   ├── token-store.ts    # In-memory token cache, on-demand auth trigger (stdio)
│   ├── session-token.ts  # Per-request bearer token via AsyncLocalStorage (HTTP)
│   └── api-token.ts      # Basic auth for stdio CI/headless escape hatch
├── client/
│   └── zendesk-api.ts    # HTTP client (fetch, error handling)
├── routing/
│   └── registry.ts       # Tool filtering (--read-only, --namespace, --tool)
├── tools/
│   ├── definitions.ts    # ToolDefinition type
│   ├── index.ts          # Aggregates all tool factories
│   ├── tickets.ts        # 10 ticket tools
│   ├── help-center.ts    # 21 Help Center tools (articles, section editing, translations, taxonomy)
│   ├── search.ts         # Unified search tool (namespace: tickets)
│   └── users.ts          # 5 user/organization tools
└── utils/
    ├── formatting.ts     # Markdown formatters per entity type
    └── pagination.ts     # Cursor-based pagination helpers
```

Transports are provided by [`fastmcp`](https://github.com/punkpeye/fastmcp) — `stdio` for local CLI use and `httpStream` (Streamable HTTP at `/mcp`) for remote deployment. fastmcp also serves `/.well-known/oauth-protected-resource` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414) in HTTP mode, advertising Zendesk as the upstream authorization server per MCP Specification 2025-06-18.

### Tool modes (pattern Azure MCP Server)

Tools are registered at startup based on `--mode`:

- **`all`** (37 individual tools) — each tool registered separately
- **`namespace`** (default, 3 proxy tools) — `zendesk_tickets`, `zendesk_help_center`, `zendesk_users`, each dispatching to sub-operations
- **`single`** (1 proxy tool) — `zendesk` dispatches to all operations

Proxy tools accept `{ operation, params }` and validate params through the original Zod schema before calling the handler.

`--namespace` and `--read-only` are applied by `filterTools` (`src/routing/registry.ts`) *before* the mode switch in `src/server.ts`. They therefore narrow every mode, including the default `namespace` mode — e.g. `--namespace help_center --read-only` registers a single `zendesk_help_center` proxy whose description only lists read-only operations. `--tool <name>` is also filtered here but additionally forces `mode: 'all'` in `src/config.ts`.

### Token passing

`createMcpServer(config, getToken)` injects a single `getToken: () => string | Promise<string>` closure into every tool handler. Where the closure pulls the token from depends on the transport:

- **stdio + OAuth** (default): `getToken` is backed by `token-store.ts`, which lazily triggers the browser PKCE flow (`browser-oauth.ts`) and caches the access token in memory.
- **stdio + API token** (CI/headless escape hatch): `getToken` returns a static Basic auth header built from `ZENDESK_EMAIL` + `ZENDESK_API_TOKEN`. **Refused at boot in HTTP mode** — see below.
- **HTTP + per-user OAuth**: `getToken` reads from `AsyncLocalStorage` (`session-token.ts`). fastmcp's `authenticate(request)` extracts the `Authorization: Bearer <token>` header on each new session; the per-tool `execute` wrapper in `server.ts` puts that token in async-local storage before calling the original handler, so the 37 handlers stay transport-agnostic.

API token authentication is **explicitly refused in HTTP mode** because a shared static credential reachable over the network would expose every user to the same rights — the anti-pattern this server's per-user OAuth design was built to avoid. The refusal is enforced in `loadConfig` (`src/config.ts`).

## Build & run

```bash
# Build (tsdown bundles to dist/index.js with shebang)
pnpm build

# Type-check without emitting
pnpm typecheck

# Lint
pnpm check
```

## Dev mode (auto-reload on file changes)

tsx watches `src/` and restarts the server automatically:

```bash
# API token mode
ZENDESK_EMAIL=you@example.com ZENDESK_API_TOKEN=xxx \
  pnpm dev -- <your-subdomain> --mode all

# OAuth mode (browser opens on first tool call)
pnpm dev -- <your-subdomain> --mode all
```

## Zendesk setup

### Option A: OAuth (browser PKCE)

1. Go to **Admin Center → Apps and integrations → APIs → OAuth Clients**
2. Create a client:
   - **Client kind**: Public
   - **Identifier**: `<your-subdomain>_zendesk` (or any name, then set `ZENDESK_OAUTH_CLIENT_ID`)
   - **Redirect URL**: `http://localhost:3000/callback`
3. Start the server (without `ZENDESK_EMAIL`/`ZENDESK_API_TOKEN`):
   ```bash
   pnpm dev -- <your-subdomain> --mode all
   ```
4. On the first tool call, a browser window opens for authentication.

### Option B: API token

1. Go to **Admin Center → Apps and integrations → APIs → Zendesk API**
2. Enable **Token Access** in Settings tab
3. Create an API token
4. Run:
   ```bash
   ZENDESK_EMAIL=you@example.com ZENDESK_API_TOKEN=xxx \
     pnpm dev -- <your-subdomain> --mode all
   ```

## Testing a tool manually

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_current_user","arguments":{}}}' | \
  ZENDESK_EMAIL=you@example.com ZENDESK_API_TOKEN=xxx \
  node dist/index.js <your-subdomain> --mode all
```

## CLI reference

```
zendesk-mcp-server <subdomain> [options]

Options:
  --mode <mode>           single | namespace (default) | all
  --namespace <ns>        Filter by namespace (repeatable): tickets, help_center, users
  --tool <name>           Filter by tool name (repeatable, forces mode all)
  --read-only             Only expose read operations
  --log-level <level>     debug | info (default) | warn | error
  --transport <t>         stdio (default) | http
  --host <host>           HTTP bind host (default: 0.0.0.0)
  --port <port>           HTTP bind port (default: 3000; 0 = OS-assigned)
  --public-url <url>      Public URL clients use to reach the server (HTTP)
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ZENDESK_SUBDOMAIN` | yes (or CLI arg) | — | Zendesk subdomain (e.g., `mycompany` for mycompany.zendesk.com) |
| `ZENDESK_OAUTH_CLIENT_ID` | no | `${subdomain}_zendesk` | OAuth client identifier |
| `ZENDESK_EMAIL` | stdio API-token mode only | — | Agent email for Basic auth (refused in HTTP) |
| `ZENDESK_API_TOKEN` | stdio API-token mode only | — | Zendesk API token (refused in HTTP) |
| `TRANSPORT` | no | `stdio` | `stdio` or `http` |
| `HOST` | no | `0.0.0.0` | HTTP bind host |
| `PORT` | no | `3000` | HTTP bind port (`0` to let the OS pick) |
| `PUBLIC_URL` | recommended in HTTP behind a proxy | derived from host:port | Public URL advertised in OAuth discovery metadata (RFC 8707). Set this when the server is behind a TLS reverse proxy — e.g. Azure App Service: `PUBLIC_URL=https://${WEBSITE_HOSTNAME}`. |
| `LOG_LEVEL` | no | `info` | Log verbosity |

In stdio mode, if both `ZENDESK_EMAIL` and `ZENDESK_API_TOKEN` are set the server uses API token authentication; otherwise it uses OAuth 2.1 PKCE (browser opens on first tool call). In HTTP mode, API token credentials are refused at boot — only per-user OAuth 2.1 PKCE is accepted (each MCP session sends its own bearer token).

## Tests

```bash
pnpm test          # Run once
pnpm test:watch    # Watch mode
```

Tests use vitest + MSW for mocking the Zendesk API.

### Testing rules

- **New features**: TDD — write a failing test first, then implement.
- **Bug fixes**: write or adapt an existing test to reproduce the bug first, then fix the code.
- **Existing tests are sacred**: a failing existing test is a potential regression. Investigate and understand WHY it fails before changing it. Never modify an existing test just to make it pass without understanding the root cause.
- **Zendesk API**: always use MSW handlers (`tests/msw-handlers.ts`) to mock Zendesk responses. Never call the real API in tests.

## Code style

- TypeScript strict (`@tsconfig/strictest` base)
- Biome for linting and formatting (`pnpm check`, `pnpm check:fix`)
- Functional style: pure functions, no classes (except `ZendeskApiError`), immutable data
- Tool handlers are standalone functions in `ToolDefinition[]` arrays, not tied to `registerTool`

## Submission quality bar

This is the bar to clear before opening a PR or asking the maintainer to
review. It applies the same way whether the code was written by a human or
by an AI assistant — the goal is that the patch survives external scrutiny
and that the human author can defend every line.

Before you submit:

1. **Re-read your own diff in full.** No skimming. If a hunk no longer makes
   sense out of the context where you wrote it, rewrite it.
2. **Justify each change.** For every non-trivial hunk, you should be able
   to answer: why is this change here, what would break without it, and is
   it the smallest version of the fix.
3. **Look for what you didn't write.** Missing zod validation on an input,
   missing test for an edge case, missing README/AGENTS update on a renamed
   tool, missing error path. Reviewers find these — find them first.
4. **Self-review prompt.** Run a Claude Code pass on the diff against
   `main` using the prompt in the
   [`CONTRIBUTING.md`](CONTRIBUTING.md#author-side-ai-review) "Author-side
   AI review" section. Address findings or document why you're skipping
   them in the PR description.
5. **Run the full local gate**: `pnpm check`, `pnpm typecheck`, `pnpm test`,
   `pnpm build`. A green CI on a non-green local run means a flaky check,
   not a free pass.
6. **Scope discipline.** Don't bundle unrelated cleanups into a feature PR.
   If you spot something worth fixing along the way, note it and open a
   separate PR.
7. **No invented behavior.** If a Zendesk API field, an SDK option, or a
   library API isn't confirmed by the docs, an existing test, or a typed
   response, mark it `// TODO:` and surface the question in the PR
   description rather than guessing.

The maintainer's review starts from the assumption that everything above
has already been done.

## Documentation maintenance

Any change to the tool surface requires a README sync in the same PR. The
README is what external users rely on — it drifts fast if ignored.

When you add, remove, rename, or meaningfully re-describe a tool, update:

- **`README.md`** — the matching row in the `Tickets` / `Help Center` / `Users & Organizations` / `Search` table, the `(N tools)` count in the `<summary>`, and the global tool count (currently **36**) wherever it appears ("Expose 36 individual tools", mode table, single-mode tip, CLI example).
- **`AGENTS.md`** — the per-file tool counts in the Architecture section (`tickets.ts # 9 ticket tools`, `help-center.ts # 21 Help Center tools`, `users.ts # 5 user/organization tools`) and the `all` mode line in "Tool modes".
- Namespace counts in `tests/unit/routing/registry.test.ts` if you touch the `help_center`, `tickets`, or `users` namespace.
- The `createHelpCenterTools` length assertion in `tests/unit/tools/help-center.test.ts` (and equivalents for other namespaces).

If you change a description in a way that alters its first sentence, remember that proxy tool descriptions (`namespace` / `single` modes) only surface that first sentence — verify it still makes sense standalone.

## Release workflow

Versions are **fully automated** via [semantic-release](https://github.com/semantic-release/semantic-release). Never bump the version manually, never run `npm version`, never touch the `version` field in `package.json` (kept at `0.0.0-semantic-release` as a placeholder).

- **Trigger**: every push to `main` runs `.github/workflows/release.yml`, which rebuilds, retests, then calls `semantic-release`.
- **Version calculation**: driven by [Conventional Commits](https://www.conventionalcommits.org/) since the previous tag.

| Commit type | Bump |
|---|---|
| `fix:`, `perf:` | patch |
| `feat:` | minor |
| `feat!:`, `fix!:`, or `BREAKING CHANGE:` footer | major |
| `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `style:`, `build:` | none (no release) |

- **Side effects of a release**: new git tag `vX.Y.Z`, `CHANGELOG.md` and `package.json` committed back to `main` with message `chore(release): X.Y.Z [skip ci]`, new GitHub Release with generated notes, new npm version published to `@fruggr/zendesk-mcp-server`.
- **npm auth**: publishing uses NPM Trusted Publishing (OIDC) — no `NPM_TOKEN` secret is stored in the repo (except during the initial bootstrap of v1.0.0, documented inline in `release.yml`).
- **If you want a release to happen**: land at least one `fix:` / `feat:` / breaking change commit in your PR. A PR made only of `chore:` / `docs:` will merge cleanly but produce no new version.
