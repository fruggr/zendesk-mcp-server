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
│   ├── tickets.ts        # 9 ticket tools
│   ├── help-center.ts    # 10 Help Center tools (articles, translations)
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

- **`all`** (25 individual tools) — each tool registered separately
- **`namespace`** (default, 3 proxy tools) — `zendesk_tickets`, `zendesk_help_center`, `zendesk_users`, each dispatching to sub-operations
- **`single`** (1 proxy tool) — `zendesk` dispatches to all operations

Proxy tools accept `{ operation, params }` and validate params through the original Zod schema before calling the handler.

### Token passing

In API token mode, a static Basic auth header is built from `ZENDESK_EMAIL` + `ZENDESK_API_TOKEN`. In OAuth mode, the token is obtained on-demand via browser PKCE flow and cached in memory by `token-store.ts`. Both modes pass a `getToken` function to tool handlers.

## Build & run

```bash
# Build (tsup bundles to dist/index.js with shebang)
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
