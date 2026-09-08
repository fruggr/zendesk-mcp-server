# zod compilation: adopted because it is free, not because it is fast

> **Build documentation, not user documentation.** This records why `src/index.ts`
> opens with `import 'zod/compile'` and what the optimisation is actually worth on
> this server. Nothing here changes how the MCP server behaves for a client — the
> exposed tool surface is byte-for-byte identical with and without it.

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-09-08 |
| **Applied in** | [#273](https://github.com/fruggr/zendesk-mcp-server/pull/273) |
| **Question** | Should the server opt into zod 4.5's AOT schema compiler, globally and transparently? |
| **Answer** | **Yes** — but on the strength of costing nothing, not of making anything measurably faster. The synchronous parses it reaches get 2–7x cheaper; that is ~2 µs against a 100–500 ms Zendesk round-trip. |

## What it is

zod 4.5 added [`z.compile()`](https://zod.dev/blog/introducing-z-compile): it walks a
schema once and emits a flat, loop-free `new Function()` fast path, keeping the
original parser as a fallback so error reporting is unchanged. `import 'zod/compile'`
is the transparent form — a side-effect import that installs a global post-processor,
so schemas built afterwards compile themselves on their first `parse`, with no call
site opting in.

## Which parses it actually reaches

Less than "everything", and the difference is invisible from the outside, so it is worth
stating precisely. The global shim **bypasses the fast path for any asynchronous parse —
and does not compile the schema at all** while doing so. Probed on a live server over
`InMemoryTransport`, one real `tools/call` per mode:

| Parse | Compiled? |
| --- | --- |
| Every JSON-RPC message — `JSONRPCMessageSchema.parse`, synchronous in stdio, SSE and streamable HTTP alike | **yes** |
| `createStrictParamsParser`'s params parse (`src/utils/validation.ts`) — the proxy dispatch path, i.e. `namespace` and `single`, the default modes | **yes** |
| `ConfigSchema.parse` at startup (`src/config.ts`) | yes, once |
| The SDK's tool-argument validation — the registered schema in `all` mode, the proxy's `{operation, params}` schema in the others | **no**: `mcp.js` uses `safeParseAsync` |

So in `all` mode no tool input schema is ever compiled, and in the default mode the
*inner* params parse is compiled while the SDK's outer one is not. Nothing can be done
about it from here: `compile()` is forward-and-synchronous by construction, and the
choice of `safeParseAsync` belongs to the SDK. `tests/unit/tools/schema-compile.test.ts`
pins both halves — that the sync path really compiles, and that the async one really
does not — so this table cannot quietly go stale.

## The argument that does *not* justify this

The zod blog leads with "~9x faster". Quoting that as a user-visible win here would be
wrong, and this section exists so nobody reaches for it later.

Every tool call in this server is one or more HTTPS round-trips to Zendesk
(`src/client/zendesk-api.ts`), i.e. 100–500 ms. The zod work on that path is one
`safeParse` of the tool's input schema plus the SDK's validation of two JSON-RPC
messages — **~2 µs saved per call, about 0.001% of it**, and less than that in `all`
mode, where the tool-input parse is the SDK's async one and is not compiled at all. No
zod schema parses Zendesk *responses*: those are plain TypeScript interfaces (`src/types.ts`), so there is no
hidden hot path. The server's real CPU cost is the unified/cheerio HTML↔Markdown
pipeline in `src/tools/help-center.ts`, which the compiler does not touch.

This was adopted because it is one line, needs a zod bump that was due anyway
([#263](https://github.com/fruggr/zendesk-mcp-server/pull/263)), adds nothing to the
bundle, and was proven not to change the exposed surface. If any of those stops being
true, the justification is gone — see *What would reverse this*.

## What was measured

On this repo's own schemas and this repo's SDK version, Node 22, 200k iterations after
warm-up (see *Reproducing*). Every row is a **synchronous** parse, i.e. one of the paths
the compiler actually reaches; the tool-input rows are the proxy params parse.

| Path | Runtime parser | Compiled | Ratio |
| --- | --- | --- | --- |
| `search_tickets` input, valid | 0.31 µs | 0.12 µs | 2.6x |
| `update_ticket` input, valid | 0.35 µs | 0.12 µs | 2.9x |
| `list_articles` input, valid | 0.54 µs | 0.25 µs | 2.2x |
| `get_article` input, valid | 0.17 µs | 0.09 µs | 1.9x |
| `search_tickets` input, **rejected** (unknown key) | 2.78 µs | 3.21 µs | **0.87x — slower** |
| SDK `JSONRPCMessageSchema`, request | 0.69 µs | 0.28 µs | 2.5x |
| SDK `JSONRPCMessageSchema`, response | 1.37 µs | 0.19 µs | 7.2x |

Costs:

| | |
| --- | --- |
| Compiling a tool schema | mean 0.62 ms, median 0.27 ms, worst `update_ticket` 1.31 ms (32.9 ms for all 53 — a ceiling nothing actually pays, since only the tools a session calls get compiled, and only in the default modes) |
| First JSON-RPC message of a process | 2.5 ms → 6.7 ms (compiling the SDK's message union); every message after: 0.13 ms → 0.02 ms |
| `dist/index.js` | 242.03 kB → 242.05 kB. zod is an external runtime dependency, not bundled, so the blog's "+7 kB gzipped" does not apply here |

Four things follow, and they are the honest shape of this change:

1. **The error path is not accelerated, and is marginally slower.** A rejected input
   falls back to the runtime parser to build its issues, having paid for the fast path
   first. `createStrictParamsParser` (`src/utils/validation.ts`) turns those issues into
   the "Unknown parameter(s): …" message, so the message itself is unchanged — the
   `unrecognized_keys` issues come through verbatim.
2. **Compilation is lazy and per schema instance.** The HTTP transport builds a
   *per-session* `McpServer` (`src/transports/http.ts`), so each session constructs its
   own tool schemas and pays ~0.27–1.31 ms the first time the proxy parser touches each
   one. A session would need roughly 1350 parses of the *same* tool's schema to earn that
   back, which never happens. **For tool input schemas under HTTP, global mode is
   therefore marginally net-negative** — a few milliseconds per session, and only for the
   tools actually called in the default modes. What stays positive everywhere is the
   SDK's module-level protocol schemas: compiled once per process, hit by every message.
3. Under stdio (one process, one session) both effects are once-per-launch and the
   break-even on protocol messages arrives after ~35 messages.
4. In `all` mode there is neither cost nor gain on tool inputs: that validation is the
   SDK's async one, so nothing there is ever compiled.

## Why it is still adopted

Because the *cost* side is as small as the benefit: no bundle growth, no API change, no
call-site churn, no new dependency. The measurements above are the reason to describe
it accurately, not a reason to skip it.

Compatibility was verified rather than assumed, and this is what makes the change safe
to leave in place:

- `z.toJSONSchema()` output identical, compiled vs not.
- The real `tools/list` payload across all three modes (`all`, `namespace`, `single` —
  128 kB of JSON) is **identical byte for byte**.
- `unrecognized_keys` issues preserved verbatim, so `createStrictParamsParser` still
  produces its exact message; the SDK's `-32602` text is unchanged too.
- The full test suite runs with compilation active — `tests/setup.ts` carries the same
  import, deliberately, so the suite exercises what ships. The trade-off is real: no
  test now covers the uncompiled path. That is the right way round, since no user runs
  it.

## Ordering is load-bearing

The post-processor only reaches schemas built by modules that evaluate **after** the
import, so `import 'zod/compile'` must be the first import of the entrypoint. Demote it
and everything still works — `tools/list` unchanged, tests green — the compilation just
silently stops happening. `src/index.ts` is outside both the coverage scope
(`vitest.config.ts`) and the mutation scope (`stryker.config.mjs`), so nothing else
would notice. Hence `tests/unit/index-compile.test.ts`, which asserts the position in
both `src/index.ts` and `tests/setup.ts`.

The same silence applies twice more, and `tests/unit/tools/schema-compile.test.ts` covers
both. A schema whose semantics the fast path cannot model is returned *unchanged*, still
on the runtime parser, with no signal — so the test compiles every tool's `.strict()`
schema under `{ strict: true }`, turning that fallback into a thrown error (all 53 compile
today). And a parse that moves from `safeParse` to `safeParseAsync` stops being compiled
with nothing else changing — so the test also asserts, on the real proxy path, that a
synchronous parse leaves the schema compiled and an asynchronous one does not.

## What would reverse this

- **A runtime without `new Function`** (a CSP-restricted or edge deployment). zod
  degrades gracefully via its `jitless` config, so nothing breaks — but the import would
  be dead weight and should be dropped rather than left as decoration.
- **A schema feature we need that the fast path cannot model.** The guard test will say
  so. Expressing the constraint differently is preferable; accepting the fallback is
  fine too, but then say which tool and why, here.
- **The SDK dropping `safeParseAsync`** — the reverse of a reversal: tool-argument
  validation would start being compiled, and the *Which parses it actually reaches* table
  above would need redoing. The guard test's async assertion is what would notice.
- **The fallback becoming observable** — a zod release where a compiled schema's errors,
  coercions or key handling differ from the runtime parser's. The byte-identical
  `tools/list` check and the full suite running compiled are what would catch it.

## Reproducing

Numbers above, from the repo root on the branch under test.

Per-message and cold-start cost, baseline vs compiled:

```js
// coldstart.mjs — run: node coldstart.mjs   /   node coldstart.mjs compile
if (process.argv[2] === 'compile') await import('zod/compile');
const { JSONRPCMessageSchema } = await import('@modelcontextprotocol/sdk/types.js');
const init = { jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } };
const t1 = process.hrtime.bigint(); JSONRPCMessageSchema.safeParse(init);
const first = Number(process.hrtime.bigint() - t1) / 1e6;
const t2 = process.hrtime.bigint(); JSONRPCMessageSchema.safeParse(init);
console.log(`first=${first.toFixed(2)}ms second=${(Number(process.hrtime.bigint() - t2) / 1e6).toFixed(3)}ms`);
```

Per-schema throughput: put a throwaway test under `tests/unit/`, build the schemas with
`createAllTools({ subdomain: 'testsubdomain', getToken: () => 'test-token' })`, and run
it twice — once normally (compiled, via `tests/setup.ts`) and once against a config with
`setupFiles: []` (the baseline). Compile cost is `z.compile()` timed over freshly built,
never-parsed schemas.

Surface identity: boot `createMcpServer` over `InMemoryTransport` for each mode, dump
`listTools()`, and diff the two runs.
