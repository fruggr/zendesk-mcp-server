import { spawn } from 'node:child_process';

const TIMEOUT_MS = 5000;
const KILL_GRACE_MS = 1000;
// Budget for the EOF check: the server's own shutdown grace is 3s, and the
// watchdog forces the exit at that point, so 5s leaves room without hanging CI.
const EXIT_TIMEOUT_MS = 5000;

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

/**
 * The assertion for #246: behind `npx` the client's exit is invisible except as
 * EOF on stdin, so once the server is ready we close stdin and nothing else.
 * **No signal is sent** — an exit here can only have come from the EOF handler.
 * A process still alive at the deadline is SIGKILLed and fails the check, as is
 * one that exits non-zero or dies on a signal.
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

      console.log('[smoke] ok (exited cleanly on stdin EOF)');
      resolve();
    });
  });

try {
  await runCheck(['smoke-test'], 'stdio_transport_ready');
  await runCheck(['smoke-test', '--transport', 'http', '--port', '0'], 'http_transport_ready');
  await runStdinEofCheck(['smoke-test'], 'stdio_transport_ready');
  process.exit(0);
} catch {
  process.exit(1);
}
