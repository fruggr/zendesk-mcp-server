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
├── index.ts              # Entry point, CLI args, auth mode selection
├── server.ts             # McpServer setup, tool registration per mode
├── config.ts             # CLI + env vars parsing (Zod validated)
├── constants.ts          # Zendesk API URLs, limits
├── types.ts              # Zendesk API response interfaces
├── auth/
│   ├── browser-oauth.ts  # OAuth 2.1 PKCE browser flow (authorize/callback/token)
│   ├── token-store.ts    # In-memory token cache, on-demand auth trigger
│   └── api-token.ts      # Basic auth for stdio mode
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
├── transports/
│   └── stdio.ts          # Stdio transport
└── utils/
    ├── formatting.ts     # Markdown formatters per entity type
    └── pagination.ts     # Cursor-based pagination helpers
```

### Tool modes (pattern Azure MCP Server)

Tools are registered at startup based on `--mode`:

- **`all`** (37 individual tools) — each tool registered separately
- **`namespace`** (default, 3 proxy tools) — `zendesk_tickets`, `zendesk_help_center`, `zendesk_users`, each dispatching to sub-operations
- **`single`** (1 proxy tool) — `zendesk` dispatches to all operations

Proxy tools accept `{ operation, params }` and validate params through the original Zod schema before calling the handler.

`--namespace` and `--read-only` are applied by `filterTools` (`src/routing/registry.ts`) *before* the mode switch in `src/server.ts`. They therefore narrow every mode, including the default `namespace` mode — e.g. `--namespace help_center --read-only` registers a single `zendesk_help_center` proxy whose description only lists read-only operations. `--tool <name>` is also filtered here but additionally forces `mode: 'all'` in `src/config.ts`.

### Token passing

In API token mode, a static Basic auth header is built from `ZENDESK_EMAIL` + `ZENDESK_API_TOKEN`. In OAuth mode, the token is obtained on-demand via browser PKCE flow and cached in memory by `token-store.ts`. Both modes pass a `getToken` function to tool handlers.

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
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ZENDESK_SUBDOMAIN` | yes (or CLI arg) | — | Zendesk subdomain (e.g., `mycompany` for mycompany.zendesk.com) |
| `ZENDESK_OAUTH_CLIENT_ID` | no | `${subdomain}_zendesk` | OAuth client identifier |
| `ZENDESK_EMAIL` | for API token auth | — | Agent email for Basic auth |
| `ZENDESK_API_TOKEN` | for API token auth | — | Zendesk API token |
| `LOG_LEVEL` | no | `info` | Log verbosity |

If both `ZENDESK_EMAIL` and `ZENDESK_API_TOKEN` are set, the server uses API token authentication. Otherwise, it uses OAuth 2.1 PKCE (browser opens on first tool call).

## Tests

```bash
pnpm test          # Run once
pnpm test:watch    # Watch mode
pnpm test:coverage # Run with v8 coverage + enforce thresholds
```

Tests use vitest + MSW for mocking the Zendesk API.

### Coverage

`pnpm test:coverage` runs the v8 coverage provider and fails if any global
threshold (configured in `vitest.config.ts`) is not met. It also writes an
HTML report to `coverage/index.html` and an `lcov.info` for editors/CI. CI runs
this on every PR and uploads the report as the `coverage-report` artifact.
Thresholds are a ratchet — raise them as coverage improves, never lower them
silently. `index.ts`, `transports/stdio.ts`, and `types.ts` are excluded (thin
bootstraps / type-only).

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

## Communication language

All written output that lands on GitHub must be in **English**, without
exception: PR titles and descriptions, commit messages, code comments, issue
and review comments, and replies to reviewers. English is the shared language
of the repository — it keeps the history readable for every contributor.

This rule covers GitHub only. When talking directly with the user (chat, CLI),
follow their local language configuration and answer in whatever language they
are using.

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
8. **Mark the PR ready for review.** A PR opened as a draft must be flipped
   to "ready for review" once development is done and the local gate is
   green — every finished PR ends in review, never left sitting as a draft.
   Flipping it out of draft is what triggers CodeRabbit and the maintainer's
   pass.

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
