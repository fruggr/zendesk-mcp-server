# Development Guide

This file is for contributors. End-user docs (install, configure, run, deploy) live in [`README.md`](README.md); refer to it for anything operational. Here we only cover what's needed to develop, test, review, and release the project.

## Setup

```bash
pnpm install
```

Toolchain (Node 24 + pnpm 11) is the dev floor; the published package still runs on Node 20+ (a CI job exercises the packed tarball on Node 20).

## Architecture

```
src/
├── index.ts        # Entry point, CLI args, transport + auth dispatch
├── server.ts       # McpServer factory: registers tools per mode
├── config.ts       # CLI + env vars parsing (Zod validated)
├── constants.ts    # Zendesk API + OAuth URLs, limits
├── types.ts        # Zendesk API response interfaces
├── auth/           # OAuth 2.1 PKCE flow + token store + API-token basic auth
├── client/         # Zendesk HTTP client (fetch wrapper, ZendeskApiError)
├── routing/        # filterTools / groupByNamespace
├── tools/          # 37 tool definitions across tickets / help_center / users / search
├── transports/     # stdio (SDK) + http (node:http + SDK StreamableHTTPServerTransport)
└── utils/          # Markdown formatting, cursor pagination
```

Transports use the official `@modelcontextprotocol/sdk` directly. HTTP is a thin `node:http` server wrapping `StreamableHTTPServerTransport` plus the OAuth discovery endpoints (RFC 9728 / RFC 8414) advertising Zendesk as the upstream authorization server.

### Tool modes

Three registration shapes, selected by `--mode` (default `namespace`):

- **`all`** — 37 individual tools
- **`namespace`** — 3 proxies (`zendesk_tickets`, `zendesk_help_center`, `zendesk_users`); each scoped to its own operations
- **`single`** — one `zendesk` proxy

`filterTools` (`src/routing/registry.ts`) applies `--read-only` / `--namespace` / `--tool` **before** the mode switch, so filters narrow every mode.

### Token passing

`createMcpServer(config, getToken)` injects one closure per server instance. Three flavors:

- **stdio + OAuth** — `getToken` resolves through `token-store.ts` (lazy browser PKCE).
- **stdio + API token** — static Basic auth header. Refused at boot in HTTP.
- **HTTP** — `src/transports/http.ts` builds a **per-session `McpServer`** with the request's bearer captured in the closure. No shared state, no async-local storage.

## Build & run

```bash
pnpm build       # tsdown → dist/index.js with shebang
pnpm typecheck   # tsc --noEmit
pnpm check       # Biome lint + format
pnpm check:fix   # Biome auto-fix
```

## Dev mode (auto-reload)

`tsx` watches `src/` and restarts on save. Default is OAuth — no env vars needed.

```bash
# Stdio + OAuth (browser opens on first tool call)
pnpm dev -- <your-subdomain> --mode all

# HTTP transport, local discovery testable via curl
pnpm dev -- <your-subdomain> --transport http --port 3000 \
  --public-url http://localhost:3000
curl -s http://localhost:3000/.well-known/oauth-protected-resource
curl -s http://localhost:3000/healthz

# Stdio + API token (only when a browser is not available)
ZENDESK_EMAIL=you@example.com ZENDESK_API_TOKEN=xxx \
  pnpm dev -- <your-subdomain> --mode all
```

Zendesk-side OAuth client setup (admin center, redirect URLs, tokens) is documented in [`README.md`](README.md#quick-start-local-stdio). For interactive debugging against a running server, use the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) (`npx @modelcontextprotocol/inspector …`).

## Tests

```bash
pnpm test          # Run once
pnpm test:watch    # Watch mode
pnpm test:smoke    # Build + spawn binary, assert stdio + http boot markers
pnpm test:coverage # Run with v8 coverage + enforce thresholds
```

Tests use vitest + MSW for mocking the Zendesk API.

### Coverage

`pnpm test:coverage` enforces the global thresholds in `vitest.config.ts`
(treat them as a ratchet) and writes `coverage/index.html` + `lcov.info`. CI
runs it on every PR.

### Testing rules

- **New features**: TDD — write a failing test first, then implement.
- **Bug fixes**: write or adapt an existing test to reproduce the bug first, then fix the code.
- **Existing tests are sacred**: a failing existing test is a potential regression. Investigate and understand WHY it fails before changing it. Never modify an existing test just to make it pass without understanding the root cause.
- **Zendesk API**: always use MSW handlers (`tests/msw-handlers.ts`) to mock Zendesk responses. Never call the real API in tests.
- **Coverage follows the surface**: when you add or change a tool, mode, filter, or transport, extend the end-to-end tests in `tests/integration/` so the roundtrip stays covered — shared, transport-agnostic behaviour belongs in `registerCoreScenarios`.

## Code style

- TypeScript strict (`@tsconfig/strictest` base)
- Biome for linting and formatting (`pnpm check`, `pnpm check:fix`)
- Functional style: pure functions, no classes (except `ZendeskApiError`), immutable data
- Tool handlers are standalone functions in `ToolDefinition[]` arrays, not tied to the MCP SDK's `registerTool`
- ASCII-only error messages on auth paths — `node:http` rejects non-ASCII bytes in `WWW-Authenticate` and other headers (`ERR_INVALID_CHAR`), which surfaces as a 500 instead of the spec-required 401

## Communication language

Everything on GitHub is in **English** (PRs, commits, code comments, review
replies). Direct chat with the user follows their language.

## Submission quality bar

This is the bar to clear before opening a PR or asking the maintainer to review. It applies the same way whether the code was written by a human or by an AI assistant — the goal is that the patch survives external scrutiny and that the human author can defend every line.

Before you submit:

1. **Re-read your own diff in full.** No skimming. If a hunk no longer makes sense out of the context where you wrote it, rewrite it.
2. **Justify each change.** For every non-trivial hunk, you should be able to answer: why is this change here, what would break without it, and is it the smallest version of the fix.
3. **Look for what you didn't write.** Missing zod validation on an input, missing test for an edge case, missing README/AGENTS update on a renamed tool, missing error path. Reviewers find these — find them first.
4. **Self-review prompt.** Run a Claude Code pass on the diff against `main` using the prompt in [`CONTRIBUTING.md`](CONTRIBUTING.md#author-side-ai-review) "Author-side AI review". Address findings or document why you're skipping them in the PR description.
5. **Run the full local gate** (the scripts listed in "Build & run" and "Tests" above, ending with `pnpm test:smoke`). A green CI on a non-green local run means a flaky check, not a free pass.
6. **Scope discipline.** Don't bundle unrelated cleanups into a feature PR. If you spot something worth fixing along the way, note it and open a separate PR.
7. **No invented behavior.** If a Zendesk API field, an SDK option, or a library API isn't confirmed by the docs, an existing test, or a typed response, mark it `// TODO:` and surface the question in the PR description rather than guessing.
8. **Mark the PR ready for review.** Flip a draft PR to "ready for review" once dev is done and the local gate is green — never leave it as a draft.

The maintainer's review starts from the assumption that everything above has already been done.

## Documentation maintenance

Any change to the tool surface requires a README sync (the per-namespace tables, the tool counts) in the same PR. Test fixtures that assert namespace counts also need to follow — grep for the namespace/tool name to find them.

If you change a tool description in a way that alters its **first sentence**, remember that proxy tool descriptions (`namespace` / `single` modes) only surface that first sentence — verify it still makes sense standalone.

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
- **npm auth**: publishing uses NPM Trusted Publishing (OIDC) — no `NPM_TOKEN` secret is stored in the repo.
- **If you want a release to happen**: land at least one `fix:` / `feat:` / breaking change commit in your PR. A PR made only of `chore:` / `docs:` will merge cleanly but produce no new version.
