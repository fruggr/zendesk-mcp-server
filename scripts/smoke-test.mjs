import { spawn } from 'node:child_process';

const TIMEOUT_MS = 5000;

const runCheck = (args, marker) =>
  new Promise((resolve, reject) => {
    const proc = spawn('node', ['dist/index.js', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let found = false;

    const onData = (chunk) => {
      output += chunk.toString();
      if (!found && output.includes(marker)) {
        found = true;
        proc.kill('SIGTERM');
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    const timer = setTimeout(() => {
      if (!found) proc.kill('SIGKILL');
    }, TIMEOUT_MS);

    proc.on('close', () => {
      clearTimeout(timer);
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
  await runCheck(['smoke-test'], 'running via stdio');
  await runCheck(['smoke-test', '--transport', 'http', '--port', '0'], 'running via http');
  process.exit(0);
} catch {
  process.exit(1);
}
