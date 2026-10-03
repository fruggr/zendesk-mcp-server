#!/usr/bin/env node
/**
 * Smoke test for the container image: `node scripts/container-smoke.mjs <image>`.
 * Runs it the hardened way docs/http-deployment.md (Container) recommends and
 * checks what the image promises: HTTP by default, non-root, no shell, writes
 * only under /data, and a clean error when the master secret is missing.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

const image = process.argv[2];
if (!image) {
  console.error('usage: node scripts/container-smoke.mjs <image>');
  process.exit(2);
}

const HARDENED = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];
const READY_TIMEOUT_MS = 30_000;
const failures = [];

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });

const check = (name, ok, detail = '') => {
  console.log(
    `[container-smoke] ${ok ? 'ok' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`,
  );
  if (!ok) failures.push(name);
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const waitFor = async (url) => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
};

const user = docker('image', 'inspect', '--format', '{{.Config.User}}', image).stdout.trim();
check('runs as UID 1000', user.split(':')[0] === '1000', `user is "${user}"`);

const shell = docker('run', '--rm', '--entrypoint', 'sh', image, '-c', 'true');
check('ships no shell', shell.status !== 0, 'sh ran');

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const run = docker(
  'run',
  '--detach',
  ...HARDENED,
  '--env',
  `OAUTH_MASTER_SECRET=${randomBytes(32).toString('base64')}`,
  '--publish',
  `127.0.0.1:${port}:3000`,
  image,
  'smoke-test',
  '--public-url',
  base,
);
const container = run.stdout.trim();
check('starts read-only, with every capability dropped', run.status === 0, run.stderr);

try {
  const health = await waitFor(`${base}/healthz`);
  check(
    'serves HTTP by default (/healthz)',
    health !== undefined,
    docker('logs', container).stderr,
  );

  const metadata = await waitFor(`${base}/.well-known/oauth-authorization-server`);
  const issuer = metadata ? (await metadata.json()).issuer : undefined;
  check('serves the authorization server metadata', issuer === base, `issuer is ${issuer}`);

  // Registering a client is the first write: it must land in /data, the only
  // writable path of a read-only container.
  const registration = await fetch(`${base}/reg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['http://127.0.0.1:9/cb'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const stored = docker('cp', `${container}:/data/oauth-store.json`, '-');
  check('persists to /data', registration.status === 201 && stored.status === 0, stored.stderr);
} finally {
  if (container) docker('rm', '--force', container);
}

const missing = docker('run', '--rm', ...HARDENED, image, 'smoke-test');
check(
  'stops with a clean, linked error without a master secret',
  missing.status !== 0 &&
    missing.stderr.includes('Set OAUTH_MASTER_SECRET') &&
    // The whole message ends on the docs link, on the line it starts.
    /^Cannot write .* See https:\/\/github\.com\/fruggr\/zendesk-mcp-server\/blob\/main\/docs\/http-deployment\.md#master-secret-and-grant-store$/m.test(
      missing.stderr,
    ) &&
    !/^\s+at /m.test(missing.stderr),
  missing.stderr,
);

if (failures.length > 0) {
  console.error(`[container-smoke] ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('[container-smoke] all checks passed');
