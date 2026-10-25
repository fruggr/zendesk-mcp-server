/**
 * Dev-only: what a stdio server built from dist/ costs idle, and what its first
 * article call adds. The idle figures come from `dist/index.js` alone, started
 * the way a client does (`initialize`, `tools/list`). The article call needs a
 * Zendesk, so it runs in a second process with the test mock preloaded, and only
 * the RSS it adds is reported: the mock's own weight would swamp the rest. Run
 * after `pnpm build`, on two builds to compare them:
 *
 *   node scripts/measure-footprint.mjs [--mode namespace|all|single] [--runs 5]
 *
 * Timings depend on the machine: compare runs on the same one. Why these
 * numbers matter: docs/decisions/startup-footprint.md.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'namespace' },
    runs: { type: 'string', default: '5' },
  },
});
const ENTRY = resolve('dist/index.js');
const MOCK = resolve('tests/bundle/zendesk-upstream.ts');

const rssMb = (pid) => {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  return Number(/VmRSS:\s+(\d+)/.exec(status)?.[1]) / 1024;
};

const start = (preload, env) => {
  const proc = spawn(
    process.execPath,
    [...preload, ENTRY, 'testsubdomain', '--mode', values.mode],
    { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] },
  );
  const replies = new Map();
  let pending = '';
  proc.stdout.on('data', (chunk) => {
    pending += chunk;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const message = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      replies.get(message.id)?.(message);
    }
  });
  let id = 0;
  // A server that dies before answering must fail the run, not hang it.
  let failure;
  const failAll = (error) => {
    failure ??= error;
    for (const [, settle] of replies) settle({ error: failure });
    replies.clear();
  };
  proc.once('error', (error) => failAll(error));
  proc.once('exit', (code, signal) =>
    failAll(new Error(`server exited (code ${code}, signal ${signal}) before answering`)),
  );
  const request = (method, params) =>
    new Promise((done, fail) => {
      if (failure) return fail(failure);
      id += 1;
      replies.set(id, (message) => {
        replies.delete(message.id ?? id);
        if (message.error)
          fail(
            message.error instanceof Error
              ? message.error
              : new Error(JSON.stringify(message.error)),
          );
        else done(message);
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  // Resolves with the time `initialize` answered, then lists the tools as a client does.
  const connect = async (started) => {
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'measure-footprint', version: '0' },
    });
    const initializeMs = performance.now() - started;
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    await request('tools/list', {});
    return { initializeMs, listedMs: performance.now() - started };
  };
  const stop = async () => {
    const exited = new Promise((done) => proc.once('exit', done));
    proc.stdin.end();
    await exited;
  };
  return { proc, request, connect, stop };
};

const measureIdle = async () => {
  const started = performance.now();
  const server = start([], {});
  const timings = await server.connect(started);
  const result = { ...timings, idleMb: rssMb(server.proc.pid) };
  await server.stop();
  return result;
};

const measureArticle = async (tokenFile) => {
  const server = start(['--import', 'tsx', '--import', MOCK], { OAUTH_TOKEN_FILE: tokenFile });
  await server.connect(performance.now());
  const before = rssMb(server.proc.pid);
  const article =
    values.mode === 'all'
      ? { name: 'get_article', arguments: { article_id: 5000 } }
      : {
          name: values.mode === 'single' ? 'zendesk' : 'zendesk_help_center',
          arguments: { operation: 'get_article', params: { article_id: 5000 } },
        };
  const { result } = await server.request('tools/call', article);
  if (result?.isError)
    throw new Error(`the article call failed: ${JSON.stringify(result.content)}`);
  const addedMb = rssMb(server.proc.pid) - before;
  await server.stop();
  return addedMb;
};

const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

const workDir = mkdtempSync(join(tmpdir(), 'measure-footprint-'));
try {
  const tokenFile = join(workDir, 'token.json');
  writeFileSync(tokenFile, JSON.stringify({ accessToken: 'zd-test', scope: 'read write' }));
  const runs = [];
  for (let run = 0; run < Number(values.runs); run += 1) {
    runs.push({ ...(await measureIdle()), articleMb: await measureArticle(tokenFile) });
  }
  const chunks = readdirSync('dist')
    .filter((file) => file.endsWith('.js'))
    .map((file) => `${file} ${(statSync(join('dist', file)).size / 1024).toFixed(0)} KB`);
  console.log(`mode ${values.mode}, median of ${runs.length} runs`);
  console.log(
    `  initialize answered after   ${median(runs.map((r) => r.initializeMs)).toFixed(0)} ms`,
  );
  console.log(`  tools/list answered after   ${median(runs.map((r) => r.listedMs)).toFixed(0)} ms`);
  console.log(`  RSS after tools/list (idle) ${median(runs.map((r) => r.idleMb)).toFixed(0)} MB`);
  console.log(
    `  RSS a first article adds    ${median(runs.map((r) => r.articleMb)).toFixed(0)} MB`,
  );
  console.log(`  chunks: ${chunks.join(', ')}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
