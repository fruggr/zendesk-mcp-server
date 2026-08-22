# Process lifecycle: why the server owns its exit

> **Build documentation, not user documentation.** This records why
> `src/utils/shutdown.ts` exists and why its triggers differ per transport.
> Client-facing symptoms are in [`docs/troubleshooting.md`](../troubleshooting.md);
> operator concerns in [`docs/http-deployment.md`](../http-deployment.md).

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-08-22 |
| **Applied in** | [#249](https://github.com/fruggr/zendesk-mcp-server/pull/249) ([#246](https://github.com/fruggr/zendesk-mcp-server/issues/246)) |
| **Question** | How should the server learn that it is done, and what must it guarantee once it does? |
| **Answer** | One idempotent shutdown path, triggered by `SIGINT`/`SIGTERM` on both transports and additionally by stdin EOF on stdio only, always ending in an explicit `exit(0)` bounded by a watchdog. |

## Why EOF at all

Behind `npx`, the `npm exec` and `sh -c` links in the chain do not relay signals,
so a stdio server never receives `SIGTERM` when its client goes away. The only
remaining evidence is EOF on stdin — and the SDK does not read it.
`StdioServerTransport` attaches exactly two listeners:

```js
this._stdin.on('data',  this._ondata);
this._stdin.on('error', this._onerror);
```

Never `'end'`, never `'close'`. `transport.onclose` fires only when *we* call
`close()`. So EOF was observed by nobody.

## Why it was not already broken

Before this change the process still exited, because nothing kept the event loop
alive. That was mostly discipline rather than luck — every timer is deliberately
`unref()`'d, and says so at its declaration (`auth/token-store.ts`,
`transports/http.ts`).

But the discipline had a hole, and it was not hypothetical. The OAuth callback
server in `auth/browser-oauth.ts` is a listening `http.Server` that is **not**
`unref()`'d; only its `authTimeout` is. A client that disappeared mid-auth left
the process alive for up to `AUTH_TIMEOUT_MS` — five minutes — on 2.18.0.

That hole is also why the shutdown ends in an explicit `exit(0)` rather than
letting the loop drain: draining would wait out that same five minutes.

## Two constraints that shaped the design

### Registering a signal handler removes a guarantee

Without a handler, `SIGTERM` terminates the process by Node's default. Adding
`process.on('SIGTERM', …)` **replaces** that default and makes the exit our
responsibility. A cleanup that stalls on an in-flight Zendesk request would
therefore produce a process that `SIGTERM` cannot kill — a worse version of the
bug being fixed.

The watchdog is what keeps that from happening: it is armed *before* cleanup
runs, so a cleanup that never settles is still bounded. It is `unref()`'d, so
having a grace period does not mean waiting one out. `SHUTDOWN_GRACE_MS` is 3s,
inside the tightest common supervisor grace — `docker stop` allows 10s and
Kubernetes 30s before their own `SIGKILL` (systemd is far laxer, 90s by default)
— because being killed by the supervisor is the unclean exit this is meant to
avoid.

### EOF only exists in flowing mode

`'end'` fires when a readable stream is *read* to exhaustion. Attaching an
`'end'` listener does not by itself resume a paused stream, and Node leaves stdin
paused until something attaches `'data'`. Measured:

| stdin | `'data'` listener | `'end'` |
| --- | --- | --- |
| `/dev/null` | yes | fires immediately |
| `/dev/null` | no | never fires |
| closed pipe | no | never fires |

Two consequences, and they pull in opposite directions.

**In stdio mode the SDK attaches `'data'`, so EOF is genuinely live** — including
at startup. `zendesk-mcp-server < /dev/null` now exits immediately, which is
intended (there is no client on the other end) and is documented as a symptom in
`troubleshooting.md`. It is also why `scripts/smoke-test.mjs` had to stop
spawning with `stdio: ['ignore', …]` and the Node 20 tarball job in `ci.yml` had
to hold stdin open: otherwise both would have quietly stopped testing that the
server *runs* and started testing that it exits.

**In HTTP mode nothing reads stdin**, so the stream stays paused and would never
report EOF even on `/dev/null`. `watchStdin: false` there is therefore not
averting a live failure — it is refusing to depend on that.  Nothing states that
stdin must stay unread in the HTTP process; the day a library, a debugger or a
future feature attaches a `'data'` listener, a server carrying an EOF handler
would start exiting as soon as its supervisor handed it `/dev/null`. Making
`watchStdin` a required option rather than a default keeps the choice at each
call site instead of resting on that invariant.

The unit suite asserts the *absence* of the stdin listener in HTTP mode, because
that is the only place the distinction is observable. The smoke check that closes
stdin against a running HTTP server pins the user-visible contract, but cannot
tell the flag apart from the paused stream and would keep passing if only one of
the two survived.

## Why the runtime is injected

`installShutdown` takes its `process` access through a `ShutdownRuntime`, and
`createRuntime(process)` is what adapts the real one. Not ceremony: `index.ts`
and `transports/stdio.ts` are excluded from coverage as thin bootstraps
(`vitest.config.ts`), so logic placed there is invisible to both the coverage
ratchet and Stryker. Putting the module in `src/utils/` instead — where
`logger.ts` already sets the precedent for cross-cutting infrastructure — brings
it inside Stryker's `mutate` scope, and injecting the process is what lets the
adapter itself be tested rather than `v8 ignore`d. The riskiest lines in the
module would otherwise have been the only ones no test could reach.

## What was not done

- **No configurable grace period.** A knob here would be a support burden with no
  demonstrated use; 3s is derived from the supervisor budget above, and tests
  override it by argument.
- **No `unref()` on the OAuth callback server.** It would paper over the orphan
  without giving the process a shutdown path, and a half-finished auth flow
  should end deliberately, not by the loop happening to empty.
- **Exit code is always 0.** A signal-triggered stop is a clean stop; `128+signum`
  would make supervisors report a normal shutdown as a failure.
