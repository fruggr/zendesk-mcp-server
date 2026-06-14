# AGENTS.md — Working guide for AI agents

**Purpose & scope.** This file orients an LLM working in this repo: where things
live and the rules that aren't obvious from the code. It is **not** user
documentation.

- **Don't document what the code already shows.** File-by-file trees, command
  listings, env-var tables, setup steps — the agent reads those from the source,
  `package.json` or the docs faster than it trusts a prose copy here, and
  duplicating them only burns context and goes stale.
- Keep each section short — durable rules and pointers, not reference material.
  When a section grows into setup steps, command listings or exhaustive detail,
  it's user-facing (→ `README.md`) or a deep dive (→ `docs/`): link it, don't
  inline it.

Toolchain (Node 24 + pnpm 11) is the dev floor; the published package still runs on Node 20+ (a CI job exercises the packed tarball on Node 20).

## Architecture

Standard MCP server under `src/` (entry `index.ts` → `server.ts`). Auth in
`auth/`, HTTP client in `client/`, tool definitions in `tools/`, tool filtering
in `routing/registry.ts`. Transports in `transports/`: stdio (SDK
`StdioServerTransport`) plus a thin `node:http` HTTP transport that wraps
`StreamableHTTPServerTransport` and serves the RFC 9728 / RFC 8414 OAuth
discovery endpoints; HTTP builds a per-session `McpServer` so the request's
bearer is captured in the tools' closure — no shared state.

**Tool modes** (chosen at startup by `--mode`): `all` (every tool individually),
`namespace` (default — one proxy per namespace), `single` (one `zendesk` proxy).
Proxies take `{ operation, params }` and validate `params` through the original
Zod schema. Each proxy dispatches only within its own scoped handler map, so a
`zendesk_tickets` proxy cannot invoke a `help_center` operation. `--namespace` /
`--read-only` / `--tool` are applied by `filterTools` *before* the mode switch;
`--tool` also forces `mode: all` (`config.ts`).

**Auth** — per-user OAuth 2.1 PKCE only, no static API-token mode. stdio: lazy
browser PKCE via `token-store.ts`. HTTP: per-session bearer captured from
`Authorization:`. Dropping API-token auth is deliberate (static shared
credential — insufficiently secure, doesn't scale to multi-user/remote); the
rationale lives in `README.md` ("What this server does *not* do").

Setup, CLI flags, env vars and auth flows live in `README.md`; manual tool
testing in `docs/live-testing.md`.

## Testing

- New features: TDD — failing test first. Bug fixes: reproduce with a test first.
- Existing tests are sacred: a failure is a potential regression — find the root
  cause before touching the test.
- Mock Zendesk with MSW (`tests/msw-handlers.ts`), never the real API.
- Extend `tests/integration/` when you add/change a tool, mode, filter or
  transport; shared behaviour goes in `registerCoreScenarios`. Coverage
  thresholds in `vitest.config.ts` are a ratchet.
- Inter-LLM functional tests (proxy annotations, `[RO]` prefix on `tools/list`)
  live in `tests/functional/`; invoke via `/functional-testing`. Details in
  `tests/functional/README.md`.

## Planning

Every implementation plan must also carry a **functional validation plan** for
the feature, written for an *independent* validator (another agent or a human) —
not the implementer. It lives in the PR description; the validator posts their
report as a PR comment (English). Author the plan with the
`functional-validation-plan` skill; the validator executes it with the
`run-validation-plan` skill — don't inline either here.

## Code style

- TypeScript strict; Biome for lint/format (`pnpm check`).
- Functional: pure functions, immutable data, no classes (except `ZendeskApiError`).
- Tool handlers are standalone functions in `ToolDefinition[]` arrays.
- ASCII-only error messages on auth paths — `node:http` rejects non-ASCII bytes
  in `WWW-Authenticate` and other headers (`ERR_INVALID_CHAR`), which surfaces
  as a 500 instead of the spec-required 401.

## Communication language

GitHub (PRs, commits, comments, code) in **English**. Chat follows the user's language.

## Multi-agent compatibility — absolute rule

Must work with every mainstream MCP agent; no PR may degrade one. New tools follow
`docs/mcp-metadata.md`.

## Documentation maintenance

Any change to the tool surface syncs the `README.md` tool tables in the same PR.
Prose and section headers are deliberately count-free (no per-section
`(N tools)` or global tool totals) — don't reintroduce hardcoded counts, they
only go stale. Exact counts still live where they're load-bearing: namespace
counts in `tests/unit/routing/registry.test.ts` and the length assertions in
`tests/unit/tools/*.test.ts` — update those. Proxy descriptions surface only the
first sentence of a tool's description — keep it standalone. Changes to the
non-tool MCP surface (server `instructions`, `resources`, `prompts`) sync the
relevant `README.md` section in the same PR.

## Submission quality bar

Before opening a PR, clear the **Submission quality bar** in
[`CONTRIBUTING.md`](CONTRIBUTING.md#submission-quality-bar) (same bar for human
and AI authors).

## Release workflow

Fully automated via semantic-release on every push to `main`. Never bump the
version or edit the `version` field in `package.json`. Land a `fix:` / `feat:` /
breaking Conventional Commit to trigger a release (`chore:` / `docs:` alone
produce none). Details: `docs/release-automation.md`.
