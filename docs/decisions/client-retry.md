# Client retry: why the policy is ours and the mechanics are hand-rolled

> **Build documentation, not user documentation.** This records why
> `src/client/retry.ts` implements its own retry loop instead of delegating to a
> library. Client-facing behaviour is described in
> [`docs/troubleshooting.md`](../troubleshooting.md).

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-08-14 |
| **Applied in** | [#236](https://github.com/fruggr/zendesk-mcp-server/pull/236) ([#193](https://github.com/fruggr/zendesk-mcp-server/issues/193)) |
| **Question** | Should the retry layer use an off-the-shelf library rather than its own loop, backoff and `Retry-After` handling? |
| **Answer** | **Not yet** — for one measured reason, not on principle: the library that removes the most is invisible to the test suite, and the one that is testable removes ~40 lines while adding a dependency last published in March 2024. |

## The argument that does *not* justify hand-rolling

Zendesk's `PUT /tickets/{id}` **appends** a comment, so replaying it emails a
customer twice. That is real, and it is why `POST`/`PUT`/`DELETE` only replay a
`429` or a connection that never opened.

It is tempting to conclude "a library would get this wrong by default, so we
write our own". That conclusion is wrong, and this section exists so nobody
reaches for it again. Every candidate below exposes that choice as
**configuration** — `methods`, a predicate, a callback. Knowing that a `PUT` is
not idempotent here is a *requirement*: it has to be stated either way, in a
config value or in a policy table. Owning the requirement never implies owning
the loop, the jitter or the header parsing. **Maintain the need, not the how.**

The decision below rests only on what was measured.

## What was measured

Spike against `undici` 8.10.0 and the repo's `msw` 2.15.0.

| | undici `RetryAgent` / `interceptors.retry` | `fetch-retry` 6.0.0 | `p-retry` |
| --- | --- | --- | --- |
| Policy expressible as config | yes (`methods`, `statusCodes`, `errorCodes`, `retry` callback) | yes (`retryOn`, `retryDelay`) | partly — HTTP-agnostic, predicate is ours |
| Works with MSW | **no** | yes | yes |
| Parses `Retry-After` for us | yes | no | no |
| Last publish | current | **2024-03-17** | 2026-03-26 |

### 1. undici's interceptor is invisible to MSW

The strongest candidate — it owns the loop, the backoff, `Retry-After` *and* the
socket handling. It is unusable here because MSW intercepts **above** the
dispatcher layer:

| Wiring | MSW intercepts | Retry runs |
| --- | --- | --- |
| global `fetch` + per-call `dispatcher` | yes | **never** |
| `setGlobalDispatcher` + global `fetch` | yes | **never** |
| `undici.fetch` + `dispatcher` | **no** | yes — against the real API |

The third row is not theoretical: the probe received a genuine
`No help desk at testsubdomain.zendesk.com` from Zendesk. So the choice would be
an untested write-safety policy, or real API calls in the suite — and
[`AGENTS.md`](../../AGENTS.md) requires MSW.

Its defaults are also unsafe for this API (`methods` includes `PUT` and `DELETE`,
`errorCodes` includes the post-send `ECONNRESET`), but per the section above that
is configuration, not an argument.

### 2. `fetch-retry` is testable, and expresses the policy exactly

A fetch-level wrapper stays above MSW. All three cases behave as specified, with
the policy living entirely in `retryOn` / `retryDelay`:

| Call | Result |
| --- | --- |
| `GET` + `500` | retried, 3 requests, ends `200` |
| `POST` + `429` (`Retry-After: 0`) | replayed once, 2 requests, ends `200` |
| `PUT` + `500` | 1 request, ends `500` — never replayed |

Two findings decide against it for now:

- **It removes less than it looks.** Gone: the loop and the backoff maths, ~40
  lines. Still ours: `parseRetryAfter` (a `retryDelay` callback must return a
  number, so someone reads the header — including the trap that
  `Date.parse('-1')` yields the year 2001), the pre-send/unknown classification,
  the error wrapping and credential redaction, the per-attempt deadline, and
  draining a discarded response body to release the socket.
- **A fetch wrapper replays the same `init`, so it replays the same
  `AbortSignal`.** With one `AbortSignal.timeout` in `init`, a first attempt that
  hits the deadline ends the call: the probe stayed at 1 request and surfaced
  `TimeoutError` with no retry. Fixable — inject a fresh signal in the fetch
  function handed to the factory, which *is* called per attempt — but it is a
  trap, and `performFetch` already avoids it by building the signal inside the
  retry thunk.

Weigh that against a dependency with no release in over two years, on the path
that keeps a customer-facing comment from being sent twice.

## What would reverse this

- **`fetch-retry` resumes releases.** The leverage stays small, but the principle
  holds; swap then.
- **The client layer stops being tested through MSW** — a local `node:http`
  server for `tests/unit/client/` would let a custom dispatcher run, unlocking
  undici's interceptor, which is the real prize since it owns `Retry-After`
  parsing too. That is a test-architecture decision in its own right, not a
  drive-by swap.

Until then the mechanics stay in `src/client/retry.ts`, where the diff gate holds
them at a 100 % mutation score.

## Reproducing

```js
// MSW + a custom undici dispatcher: intercepted, but the retry never runs.
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { Agent, interceptors } from 'undici';

let hits = 0;
const server = setupServer(
  http.get('https://testsubdomain.zendesk.com/api/v2/flaky', () => {
    hits += 1;
    return hits === 1 ? HttpResponse.json({}, { status: 500 }) : HttpResponse.json({ ok: true });
  }),
);
server.listen();

const agent = new Agent().compose(interceptors.retry({ maxRetries: 2, methods: ['GET'] }));
const res = await fetch('https://testsubdomain.zendesk.com/api/v2/flaky', { dispatcher: agent });
console.log(res.status, hits); // 500 1 — one attempt, no retry
```
