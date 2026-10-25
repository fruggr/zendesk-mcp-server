# Startup footprint: what an idle server costs, and keeping it down

> **Build documentation, not user documentation.** This records why the article
> pipeline loads on demand and why CI watches the bundle's size in two tiers.
> How tool definitions are shared across requests is in
> [`tool-definitions-lifetime.md`](tool-definitions-lifetime.md); how a stdio
> server ends when its client leaves, in [`lifecycle-shutdown.md`](lifecycle-shutdown.md).

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-10-24 |
| **Applied in** | [#406](https://github.com/fruggr/zendesk-mcp-server/pull/406) ([#393](https://github.com/fruggr/zendesk-mcp-server/issues/393)) |
| **Question** | What does a server cost before it serves anything, and how do we keep that from growing unnoticed? |
| **Answer** | Load what only some tools need on their first call, and fail CI when a chunk of the bundle grows more than 10 % over its reference, or past a ceiling fixed at 1.5 × the size measured here. |

## Why an idle server matters

Over HTTP one process serves a whole company: what it costs at start is paid
once. Over stdio it is the other way round. A client starts one server per
session, and a project can preload this server in every session in case
Zendesk comes up: an engineer with several sessions open runs several servers,
most of them never called. Colleagues have seen hundreds of these processes at
~100 MB each on one machine. Every megabyte an idle server holds is multiplied
by that count, and so is a process that outlives its client.

An idle server is not the same as an unused one: a client sends `tools/list`
right after `initialize`, to know what to offer the model. The tool
definitions, their names, descriptions and JSON Schemas, are needed at
connection, so they cannot wait for the first tool call (they are built once,
about 60 ms at a cold start). What can wait is the code only some handlers run.

## What the start loaded, measured

`scripts/measure-footprint.mjs` on the build of `main` at the start of #406 and
on its end, same machine, three series of 5 runs each (medians). Idle is
`initialize` then `tools/list` on `dist/index.js` alone; the article line adds
the RSS a first `get_article` adds, measured in a process carrying the test
mock (one series of the branch read +30 MB once, against +16–17 MB otherwise):

| | Before | After |
| --- | ---: | ---: |
| `initialize` answered after | ~390–400 ms | ~300 ms |
| `tools/list` answered after | ~400–410 ms | ~315 ms |
| RSS, idle | ~110 MB | ~93 MB |
| RSS after a first article | ~130 MB | ~110 MB |
| `dist/index.js` | 4.0 MB | 1.4 MB |

The idle gain reproduced elsewhere; the article line did not. The independent
validation of #406, on Android/Termux, measured idle RSS at ~80 MB against
~93 MB, but idle plus a first article at ~105 MB against ~99 MB: the pipeline
adds 24–29 MB when it loads on demand, 4–8 MB on `main` where it is already in.
What is certain is that a server that never converts an article no longer pays
for the pipeline. Once it does, the total depends on the machine, and can be a
few MB higher than before.

A bare Node process holds ~42 MB. Of the 4.0 MB chunk every start parsed and
ran, about 2.6 MB was the HTML <-> Markdown pipeline (`src/utils/article-sections.ts`:
cheerio, unified, remark, rehype, micromark, parse5) and what cheerio's full
entry pulls in (`undici` 0.9 MB and `iconv-lite` 0.3 MB, for `fromURL` and
encoding sniffing we never use). Only the Help Center article tools and
resources convert HTML; the ticketing side never does.

The pipeline now loads through `loadArticleFormat()` (`src/utils/article-format.ts`),
a memoised dynamic import: the bundler puts it in its own chunk, and the first
call that converts an article loads it. `tests/unit/module-graph.test.ts` keeps
it off the static graph of `src/index.ts` and both transports, as it already did
for `open` and `oidc-provider`. What every start still loads is the MCP SDK
(~0.8 MB), zod (~0.25 MB) and our own code (~0.35 MB).

### Tried and rejected: `cheerio/slim`

`cheerio/slim` parses with htmlparser2 instead of parse5 and drops `undici` and
`iconv-lite`. Its serializer writes non-ASCII characters as numeric references
(`é` becomes `&#xe9;`), which breaks what #331 pins for an updated section:
named entities written back as characters. The full `cheerio` stays; it is
loaded on demand anyway.

### Not done here

`oidc-provider` brings `mime-db` (~0.37 MB) into the HTTP chunk. It loads once
per HTTP process, never on stdio: not worth a fork or a patch today. The bundle
report shows it, so the day it matters is visible.

## Watching the bundle's size

A dependency upgrade can double a chunk without a line of our code changing, and
a new import can drag a transitive tree into every start. Nobody reads bundle
sizes by hand, so CI does, after `pnpm build`, with `scripts/bundle-size.mjs`:
a table of every chunk in the job summary on every run, and a failure when a
tier is crossed. The failure lists the largest packages of the chunk, which is
usually enough to name the culprit.

Chunks are named without their content hash (`http-DLa2DU80.js` is `http`). A
new chunk, or a referenced chunk that is no longer built, also fails: either
is a change to what ships that someone should see.

### Tier 1: a reference that moves (`bundle-budget.json`)

One reference per chunk. A chunk more than 10 % over its reference fails
(small chunks get a 4 KB floor instead, or 300 bytes would fail a 3 KB chunk).
This is a tripwire, not a limit: when the growth is justified, the PR raises
the reference and says why in its description. When a chunk falls under 80 % of
its reference, the report suggests lowering it, so the tripwire stays tight.

On its own this tier never ends: ten justified raises of 10 % are a 2.6× bundle,
each of them reasonable on the day.

### Tier 2: a ceiling that does not (`bundle-ceiling.json`)

The ceiling is 1.5 × the size measured at the end of #406, on the chunks every
process loads (`index`, `http`) and on the total. It is checked against the
real size, whatever the references say, so raising a reference never gets past
it. Hitting it means the bundle grew by half since this decision: the answer is
to shrink it, not to move the ceiling.

Raising it anyway is deliberately hard, with four locks:

1. **The ADR.** The table below is the ceiling's other copy, and
   `tests/unit/bundle-ceiling.test.ts` fails unless both agree. A raise
   therefore edits this file, and adds a section saying why.
2. **A label.** `.github/workflows/bundle-ceiling-guard.yml` fails a PR that
   changes `bundle-ceiling.json` until a maintainer adds `bundle-ceiling-raise`.
3. **Code owners.** `.github/CODEOWNERS` gives the ceiling, the script and the
   guard to the repository owner. It binds once "Require review from Code
   Owners" is on in `main`'s branch protection.
4. **Agents.** `AGENTS.md` tells an agent never to raise the ceiling: it stops
   and asks the owner. It may raise a tier-1 reference, with a reason.

The ceiling in force (bytes):

<!-- bundle-ceiling:start -->
| Entry | Baseline | Ceiling |
| --- | ---: | ---: |
| `index` | 1435990 | 2153985 |
| `http` | 1213251 | 1819876 |
| `total` | 5334867 | 8002300 |

Factor 1.5, baseline measured at `40c49a8` on 2026-10-24.
<!-- bundle-ceiling:end -->

### Why sizes and not timings

A budget on start time or RSS would be closer to what users feel, but it
depends on the runner: shared CI machines vary by more than the regressions it
should catch, and a check that fails at random gets ignored. Bytes on disk are
exact and reproducible from the lockfile. The timings above come from
`scripts/measure-footprint.mjs`, run by hand to compare two builds.
