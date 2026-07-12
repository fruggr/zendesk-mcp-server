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

## Claim before you build — no duplicate work

Parallel duplicate work has happened here. Before coding an issue: re-read it
live (closed `completed` / `released` → it already shipped, stop); search open
*and* merged PRs for its number (`is:pr #<n>`) — coordinate on an open one,
don't fork; then self-assign, drop a "picking this up" comment, and open your PR
as a draft early. Link the issue in the PR **description** with a closing keyword
(`Closes #<n>` — not `Implements`/bare `#<n>`, which don't close it) so it
auto-closes on squash-merge to `main`. Need a follow-up on already-shipped work?
Open a *new* issue for the delta. Fuller checklist in `CONTRIBUTING.md`.

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

Local setup and auth flows live in `README.md`; CLI flags and env vars in
`docs/configuration.md`; remote HTTP deployment in `docs/http-deployment.md`;
troubleshooting in `docs/troubleshooting.md`; manual tool testing in
`docs/live-testing.md`.

## Design principle — usage-first, not API-shaped

Design every tool for what an LLM needs to accomplish a real task, not for what
the Zendesk API happens to expose. The API's endpoints, names, pagination and
data shapes are an implementation detail, not a template — they may be awkward or
built for a use case that isn't ours. Don't mirror them 1:1, and don't copy other
MCP servers just because they exist; neither is evidence of what serves the LLM.
A single tool may fan out to several Zendesk calls and join, reshape or drop the
result to hand back exactly what the use case needs — that cross-calling is
expected, not a smell. When API shape and usage pull apart, follow the usage. (This
never overrides the multi-agent rule below: internal naming coherence and the
quality bar still hold — the freedom is from Zendesk's shape, not from craft.)

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

Must work with every mainstream MCP agent; no PR may degrade one. Every **new
tool** must meet the Glama Tool Definition Quality bar (clear purpose, usage
guidelines, stated side effects, per-parameter `.describe()`) and keep the tool
set coherent (naming, disambiguation, no needless duplication) — the server
score is `60% mean + 40% min`, so one weak tool drags the whole surface down.
Every **tool change** must keep the exposed JSON Schema (draft-07) a *superset*
of the previous one: enrich freely, but never drop a field, loosen a type, or
shorten an existing description. Criteria, the checklist and how to diff the
schema: `docs/mcp-metadata.md`.

## Documentation maintenance

Any change to the tool surface syncs the tool tables in
`docs/mcp-tools-reference.md` (and, if a whole namespace appears or disappears,
the namespace list in the `README.md` "Available tools" section) in the same PR.
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

Fully automated via semantic-release on push to `main`; never hand-bump
`version` in `package.json` or the version-controlled `server.json` — release
syncs both. Reseed `server.json` with `pnpm build:server-json` when its metadata
changes. Details: `docs/release-automation.md`.
