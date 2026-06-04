import { spawn } from 'node:child_process';

const MARKER = 'stdio_transport_ready';
const TIMEOUT_MS = 5000;

const proc = spawn('node', ['dist/index.js', 'smoke-test'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let found = false;

const onData = (chunk) => {
  output += chunk.toString();
  if (!found && output.includes(MARKER)) {
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
    console.log(`[smoke] ok (found "${MARKER}")`);
    process.exit(0);
  }
  console.error(`[smoke] fail: marker "${MARKER}" not seen in ${TIMEOUT_MS}ms`);
  console.error('--- captured output ---');
  console.error(output || '(empty)');
  process.exit(1);
});
