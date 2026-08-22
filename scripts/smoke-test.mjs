import { spawn } from 'node:child_process';

const TIMEOUT_MS = 5000;
const KILL_GRACE_MS = 1000;
// Budget for the EOF check: the server's own shutdown grace is 3s, and the
// watchdog forces the exit at that point, so 5s leaves room without hanging CI.
const EXIT_TIMEOUT_MS = 5000;
// How long the HTTP server must keep running after its stdin reaches EOF.
const SURVIVE_MS = 1000;

// Markers are structured logger events. Force LOG_LEVEL=info so an inherited
// LOG_LEVEL=warn/error can't suppress the marker and false-fail the smoke test.
//
// stdin is a real pipe rather than `'ignore'`: `'ignore'` maps to `/dev/null`,
// which reaches EOF immediately, and EOF is now a shutdown trigger in stdio
// mode. A pipe also mirrors how a client actually launches the server.
const spawnServer = (args) =>
  spawn('node', ['dist/index.js', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LOG_LEVEL: 'info' },
  });

const runCheck = (args, marker) =>
  new Promise((resolve, reject) => {
    const proc = spawnServer(args);

    let output = '';
    let found = false;
    let timer;
    let killTimer;

    const onData = (chunk) => {
      output += chunk.toString();
      if (!found && output.includes(marker)) {
        found = true;
        clearTimeout(timer);
        proc.kill('SIGTERM');
        // Fallback: if the child ignores SIGTERM (some stuck Node loops do)
        // escalate to SIGKILL so the promise never hangs after a successful
        // marker detection.
        killTimer = setTimeout(() => proc.kill('SIGKILL'), KILL_GRACE_MS);
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    timer = setTimeout(() => {
      if (!found) proc.kill('SIGKILL');
    }, TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      console.error(`[smoke] spawn error: ${err.message}`);
      reject(err);
    });

    proc.on('close', () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (found) {
        console.log(`[smoke] ok (found "${marker}")`);
        resolve();
      } else {
        console.error(`[smoke] fail: marker "${marker}" not seen in ${TIMEOUT_MS}ms`);
        console.error('--- captured output ---');
        console.error(output || '(empty)');
        reject(new Error(`marker not found: ${marker}`));
      }
    });
  });

// Proof that the *designed* path ran. A clean exit alone is not evidence: before
// #246 the process also exited on EOF, just circumstantially, because nothing
// happened to be holding the event loop open. Requiring this marker is what
// distinguishes "shut down deliberately" from "fell over by luck" — the whole
// point of the issue.
const SHUTDOWN_MARKER = 'shutdown_started reason=stdin_eof';
// The clean *end* of that same path. `shutdown_started` alone is not enough:
// a cleanup that hangs is cut short by the server's own watchdog, which logs
// `shutdown_forced`, exits 0 too, and does so at the 3s grace — inside this
// check's deadline. Requiring the completion marker, and refusing the forced
// one, is what keeps "shut down cleanly" distinct from "was cut short".
const SHUTDOWN_DONE_MARKER = 'shutdown_complete reason=stdin_eof';
const SHUTDOWN_FORCED_MARKER = 'shutdown_forced';

/**
 * The assertion for #246: behind `npx` the client's exit is invisible except as
 * EOF on stdin, so once the server is ready we close stdin and nothing else.
 * **No signal is sent.** The server must then log that it is shutting down
 * because of EOF, and exit 0 of its own accord. A process still alive at the
 * deadline is SIGKILLed and fails the check, as is one that exits non-zero,
 * dies on a signal, or exits without having taken the shutdown path.
 */
const runStdinEofCheck = (args, marker) =>
  new Promise((resolve, reject) => {
    const proc = spawnServer(args);

    let output = '';
    let ready = false;
    let timedOut = false;
    let readyTimer;
    let exitTimer;

    const fail = (message) => {
      console.error(`[smoke] fail: ${message}`);
      console.error('--- captured output ---');
      console.error(output || '(empty)');
      reject(new Error(message));
    };

    const onData = (chunk) => {
      output += chunk.toString();
      if (!ready && output.includes(marker)) {
        ready = true;
        clearTimeout(readyTimer);
        // The whole point: EOF only, no signal.
        proc.stdin.end();
        exitTimer = setTimeout(() => {
          timedOut = true;
          proc.kill('SIGKILL');
        }, EXIT_TIMEOUT_MS);
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    readyTimer = setTimeout(() => {
      if (!ready) proc.kill('SIGKILL');
    }, TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(readyTimer);
      clearTimeout(exitTimer);
      console.error(`[smoke] spawn error: ${err.message}`);
      reject(err);
    });

    proc.on('close', (code, signal) => {
      clearTimeout(readyTimer);
      clearTimeout(exitTimer);

      if (!ready) return fail(`marker "${marker}" not seen in ${TIMEOUT_MS}ms`);
      if (timedOut) {
        return fail(`still running ${EXIT_TIMEOUT_MS}ms after stdin closed (had to SIGKILL)`);
      }
      if (signal) return fail(`exited on ${signal} rather than by itself`);
      if (code !== 0) return fail(`exited with code ${code}, expected 0`);
      if (!output.includes(SHUTDOWN_MARKER)) {
        return fail(`exited without "${SHUTDOWN_MARKER}" — no deliberate shutdown ran`);
      }
      if (output.includes(SHUTDOWN_FORCED_MARKER)) {
        return fail(`logged "${SHUTDOWN_FORCED_MARKER}" — the watchdog cut the cleanup short`);
      }
      if (!output.includes(SHUTDOWN_DONE_MARKER)) {
        return fail(`exited without "${SHUTDOWN_DONE_MARKER}" — the shutdown never finished`);
      }

      console.log('[smoke] ok (shut down deliberately on stdin EOF)');
      resolve();
    });
  });

/**
 * The inverse contract: closing stdin must not stop an HTTP server, however it
 * is supervised.
 *
 * Two independent things currently guarantee that — `watchStdin: false` in
 * `src/index.ts`, and the fact that nothing reads stdin in HTTP mode, so the
 * stream stays paused and never reports EOF. This check cannot tell them apart
 * and will keep passing if only one survives. It is here to pin the observable
 * behaviour, not to police the flag; `installShutdown`'s unit suite is what
 * asserts that no stdin listener is registered.
 */
const runStdinIgnoredCheck = (args, marker) =>
  new Promise((resolve, reject) => {
    const proc = spawnServer(args);

    let output = '';
    let ready = false;
    let settled = false;
    let hadToKill = false;
    let readyTimer;
    let aliveTimer;
    let killTimer;

    const fail = (message) => {
      console.error(`[smoke] fail: ${message}`);
      console.error('--- captured output ---');
      console.error(output || '(empty)');
      reject(new Error(message));
    };

    const onData = (chunk) => {
      output += chunk.toString();
      if (!ready && output.includes(marker)) {
        ready = true;
        clearTimeout(readyTimer);
        proc.stdin.end();
        // Survive the EOF, then stop the server the way a supervisor would.
        aliveTimer = setTimeout(() => {
          settled = true;
          proc.kill('SIGTERM');
          // A server that does not honour SIGTERM must *fail* this check, not
          // hang it: without the escalation the promise would never settle and
          // CI would sit until its job timeout with no diagnosis.
          killTimer = setTimeout(() => {
            hadToKill = true;
            proc.kill('SIGKILL');
          }, EXIT_TIMEOUT_MS);
        }, SURVIVE_MS);
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    readyTimer = setTimeout(() => {
      if (!ready) proc.kill('SIGKILL');
    }, TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(readyTimer);
      clearTimeout(aliveTimer);
      clearTimeout(killTimer);
      console.error(`[smoke] spawn error: ${err.message}`);
      reject(err);
    });

    proc.on('close', () => {
      clearTimeout(readyTimer);
      clearTimeout(aliveTimer);
      clearTimeout(killTimer);

      if (!ready) return fail(`marker "${marker}" not seen in ${TIMEOUT_MS}ms`);
      if (!settled) {
        return fail(`HTTP server exited within ${SURVIVE_MS}ms of stdin EOF; it must ignore stdin`);
      }
      if (hadToKill) {
        return fail(`still running ${EXIT_TIMEOUT_MS}ms after SIGTERM (had to SIGKILL)`);
      }

      console.log('[smoke] ok (survived stdin EOF in http mode)');
      resolve();
    });
  });

const HTTP_ARGS = ['smoke-test', '--transport', 'http', '--port', '0'];

try {
  await runCheck(['smoke-test'], 'stdio_transport_ready');
  await runCheck(HTTP_ARGS, 'http_transport_ready');
  await runStdinEofCheck(['smoke-test'], 'stdio_transport_ready');
  await runStdinIgnoredCheck(HTTP_ARGS, 'http_transport_ready');
  process.exit(0);
} catch {
  process.exit(1);
}
