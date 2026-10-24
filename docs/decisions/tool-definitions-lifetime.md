# Tool definitions: built once per process, the caller passed per call

> **Build documentation, not user documentation.** This records why a tool
> handler takes the user it acts for from its call instead of from its closure,
> and what else was weighed. What an idle server costs, and the bundle-size
> watch, are in [`startup-footprint.md`](startup-footprint.md).

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-10-24 |
| **Applied in** | [#406](https://github.com/fruggr/zendesk-mcp-server/pull/406) ([#393](https://github.com/fruggr/zendesk-mcp-server/issues/393)) |
| **Question** | How long should a tool definition live, when one HTTP process serves many users and the 2026-07-28 revision builds a server per request? |
| **Answer** | As long as the process. Definitions are built from the server's config alone (`ToolEnv`); each call carries its caller (`ToolCaller`: token source, brand resolver, SLA service). |

## The cost that started it

Over HTTP, the 2026-07-28 revision gets a fresh `McpServer` for every request
([`protocol-eras.md`](protocol-eras.md)). Building one meant building the whole
tool surface: profiled on `main`, about 90 % of it was zod constructing the
input schemas inside `createAllTools`, then the garbage collector reclaiming
them. In `all` mode the SDK also converted every schema to JSON Schema on each
`tools/list`, since zod does not cache that conversion. Per request, measured:

| `--mode` | Server build + `tools/list` + one call's validation |
| --- | ---: |
| `all` | ~9 ms |
| `namespace` (default) | ~4.5–5 ms |
| `single` | ~4–4.5 ms |

Synchronous CPU: it blocks the event loop, so every other request on the
process waits too.

## Why the definitions were rebuilt at all

The handlers captured the user's token in their closure: each user's server
built its own tools around its own `getToken`. That was how isolation was
achieved when the HTTP transport arrived (#40): a server per session, so the
token in a tool's closure was that session's. It made the definitions as
per-user as the token, though nothing in a schema or a description depends on
the user. Only `subdomain` and `brandIds` shape them, and both are the server's.

## What was weighed

**A cache per grant.** Keep each grant's definitions next to its Help Center
caches. Requests became cheap (~0.1–0.45 ms), but each grant then held its
definitions: ~1.5 MB measured, twice for a grant presenting both write and
read-only tokens, kept until the grant has been idle 30 minutes. A thousand
active grants is 1.5–3 GB for identical copies. It was the first version of
#406, and the measurement is what ended it.

**Schemas shared by key, closures kept.** Wrap every schema in a process-wide
cache keyed by tool and config. Per-grant memory fell to ~35 KB, with a small
diff. But nothing checks that the key covers everything a schema depends on: in
the proof of concept, a codemod keyed two schemas alike and
`list_promoted_articles` silently got `list_articles`'s schema. Only the
`tools/list` surface snapshot caught it.

**An implicit context (`AsyncLocalStorage`).** Build the definitions once and
read the current user from async-local storage. No handler changes. But the
user then flows by convention: work that leaves the request's async scope (a
timer, a poller, a cached promise) would run without a user, or with another
one, and the type system cannot see it.

**Definitions per process, the caller per call (chosen).** A handler's
signature is `(params, { caller, canElicit, inputResponses })`. A definition
cannot reach a token except through the call it is handling, and TypeScript
enforces that: there is nothing to key and nothing implicit. The cost was a
mechanical change to every tool file (`getToken()` became
`caller.getToken()`), done one file per commit.

## The invariant

`AGENTS.md` used to say the token "is captured in the tools' closure", which
described the old mechanism rather than the rule. It now states the rule: a
user's Zendesk token never lives in process-wide state; it reaches a tool only
through the context the transport builds for that user. The definitions are
process-wide and hold no user. The caller is built with each server, from that
user's token source, brand resolver and SLA service.

## How it fits together

- `createAllTools(env)` builds the definitions from a `ToolEnv`. The HTTP
  transport calls it once at start and hands the same array to every session's
  and every request's server (`ServerBuildContext.tools`). stdio has one server
  per process and builds them with it. `--dev` reload rebuilds them from the
  re-imported modules.
- `registerToolset` builds the `ToolCaller` and passes it with every call, in
  all three modes; a proxy dispatches with it too.
- What hangs off a schema is built once per schema, in `WeakMap`s keyed by the
  zod object (`src/utils/validation.ts`): the strict Standard Schema wrapper,
  the proxy parameter parser, and the JSON Schema conversion per direction and
  target. A proxy's own `{ operation, params }` schema, description and
  annotations are kept per set of definitions (`src/server.ts`). Shared schema
  objects also mean zod compiles each one once per process
  ([`zod-compile.md`](zod-compile.md)).

## Measured after

| `--mode` | Per 2026-07-28 request | Tools held per grant |
| --- | ---: | ---: |
| `all` | ~0.7 ms | 0 |
| `namespace` | ~0.2 ms | 0 |
| `single` | ~0.15 ms | 0 |

The definitions cost ~1.5 MB once per process. A request still builds a server
and registers the tools on it: the SDK's 2026-07-28 handler asks its factory for
an instance per request and refuses one that is already serving, so that part
stays. It is now the whole cost.

## What guards it

- `tests/integration/protocol-eras.test.ts` interleaves `get_current_user`
  calls from two grants with distinct Zendesk tokens, the mock answering per
  token: each must see its own user. Making every server share the first
  server's caller fails it, which was checked.
- The same file checks that every request and every grant gets the transport's
  definitions, and that each grant keeps its own token source.
- `tests/unit/server.test.ts` checks that servers built from the same
  definitions register the same schema objects, and that each still filters
  them with its own config (`--read-only` narrowed per token).
