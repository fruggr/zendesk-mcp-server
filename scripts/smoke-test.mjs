import { spawn } from 'node:child_process';

const TIMEOUT_MS = 5000;
const KILL_GRACE_MS = 1000;

// Markers are structured logger events. Force LOG_LEVEL=info so an inherited
// LOG_LEVEL=warn/error can't suppress the marker and false-fail the smoke test.
const runCheck = (args, marker) =>
  new Promise((resolve, reject) => {
    const proc = spawn('node', ['dist/index.js', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LOG_LEVEL: 'info' },
    });

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

try {
  await runCheck(['smoke-test'], 'stdio_transport_ready');
  await runCheck(['smoke-test', '--transport', 'http', '--port', '0'], 'http_transport_ready');
  process.exit(0);
} catch {
  process.exit(1);
}
