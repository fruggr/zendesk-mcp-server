// Executes the retry/timeout validation matrix and prints a report.
//
//   pnpm build && node scripts/validate-retry.mjs [--skip-slow]
//
// Each scenario boots the real server behind `scripts/fault-inject.mjs`, drives a
// real MCP tool call over stdio, and judges the outcome on two things: what the
// caller received, and **how many requests Zendesk actually saw**. The count is
// what proves the write-safety guarantee — a message can be misread, a counter
// cannot.
//
// Exits non-zero if any scenario fails, so a green run is a fact rather than an
// impression. `--skip-slow` drops the 30 s deadline scenario.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUB = 'validation';
const SERVER = 'dist/index.js';
const PRELOAD = 'scripts/fault-inject.mjs';
const skipSlow = process.argv.includes('--skip-slow');

const NOTE_MAY_APPLY = 'The write may already have been applied.';
const NOTE_REFUSED = 'Zendesk refused the request, so nothing was applied.';

const SCENARIOS = [
  {
    id: 'S1',
    what: 'a healthy read goes through untouched',
    fault: 'none',
    tool: 'get_current_user',
    args: {},
    expect: { requests: 1, isError: false },
  },
  {
    id: 'S2',
    what: 'a transient failure is absorbed, the caller never sees it',
    fault: 'flaky-then-ok',
    tool: 'get_current_user',
    args: {},
    expect: { requests: 2, isError: false },
  },
  {
    id: 'S3',
    what: 'a read spends its whole budget on a 5xx',
    fault: '500',
    tool: 'get_current_user',
    args: {},
    expect: { requests: 3, isError: true, contains: ['Zendesk API error 500'] },
  },
  {
    id: 'S4',
    what: 'a 5xx write is never replayed, and says it may have applied',
    fault: '500',
    tool: 'add_private_note',
    args: { ticket_id: 1, body: 'validation note' },
    expect: { requests: 1, isError: true, contains: [NOTE_MAY_APPLY] },
  },
  {
    id: 'S5',
    what: 'a throttled write is refused outright, so retrying is safe',
    fault: '429',
    tool: 'add_private_note',
    args: { ticket_id: 1, body: 'validation note' },
    expect: { requests: 1, isError: true, contains: ['Rate limit exceeded', NOTE_REFUSED] },
  },
  {
    id: 'S6',
    what: 'a write that failed with no response is not replayed either',
    fault: 'network',
    tool: 'add_private_note',
    args: { ticket_id: 1, body: 'validation note' },
    expect: {
      requests: 1,
      isError: true,
      contains: ['Network error on PUT', NOTE_MAY_APPLY],
      absent: ['Bearer', 'accessToken'],
    },
  },
  {
    id: 'S7',
    what: 'a read retries a failure with no response, then names it',
    fault: 'network',
    tool: 'get_current_user',
    args: {},
    expect: { requests: 3, isError: true, contains: ['Network error on GET', 'after 3 attempts'] },
  },
  {
    id: 'S8',
    slow: true,
    what: 'a stalled socket is cut by the per-attempt deadline, not left hanging',
    fault: 'stall',
    tool: 'add_private_note',
    args: { ticket_id: 1, body: 'validation note' },
    expect: { requests: 1, isError: true, contains: ['TimeoutError'], minMs: 29_000 },
  },
];

const seedTokenFile = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'zendesk-validation-')), 'token.json');
  // A non-expiring token: the server reuses it and never opens a browser.
  writeFileSync(file, JSON.stringify({ accessToken: 'validation-token' }), { mode: 0o600 });
  return file;
};

const runScenario = (scenario, tokenPath) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', `./${PRELOAD}`, SERVER, SUB, '--mode', 'all'],
      {
        env: {
          ...process.env,
          SUB,
          FAULT: scenario.fault,
          ZENDESK_TOKEN_FILE: tokenPath,
          ZENDESK_OAUTH_CLIENT_ID: 'validation_client',
          LOG_LEVEL: 'error',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let requests = 0;
    let stdout = '';
    let settled = false;
    const started = Date.now();

    child.stderr.on('data', (chunk) => {
      requests += (chunk.toString().match(/\[fault] hit #/g) ?? []).length;
    });

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ...outcome, requests, elapsedMs: Date.now() - started });
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== 2) continue;
        const payload = message.result ?? message.error;
        const text =
          payload?.content?.map((part) => part.text).join('\n') ??
          payload?.message ??
          JSON.stringify(payload);
        finish({ isError: Boolean(payload?.isError ?? message.error), text });
      }
    });

    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'validate-retry', version: '0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: scenario.tool, arguments: scenario.args },
    });

    setTimeout(() => finish({ isError: true, text: '<no response within 60 s>' }), 60_000);
  });

const judge = (scenario, outcome) => {
  const { expect } = scenario;
  const failures = [];
  if (outcome.requests !== expect.requests) {
    failures.push(`Zendesk saw ${outcome.requests} request(s), expected ${expect.requests}`);
  }
  if (outcome.isError !== expect.isError) {
    failures.push(`isError=${outcome.isError}, expected ${expect.isError}`);
  }
  for (const needle of expect.contains ?? []) {
    if (!outcome.text.includes(needle)) failures.push(`message is missing "${needle}"`);
  }
  for (const needle of expect.absent ?? []) {
    if (outcome.text.includes(needle)) failures.push(`message leaks "${needle}"`);
  }
  if (expect.minMs !== undefined && outcome.elapsedMs < expect.minMs) {
    failures.push(`returned after ${outcome.elapsedMs} ms, expected at least ${expect.minMs} ms`);
  }
  return failures;
};

if (!existsSync(SERVER)) {
  console.error(`${SERVER} is missing. Run \`pnpm build\` first.`);
  process.exit(1);
}

const tokenFile = seedTokenFile();
const chosen = SCENARIOS.filter((scenario) => !(scenario.slow && skipSlow));
let failed = 0;

console.log(`Retry and timeout validation — ${chosen.length} scenarios\n`);

for (const scenario of chosen) {
  const outcome = await runScenario(scenario, tokenFile);
  const failures = judge(scenario, outcome);
  const verdict = failures.length === 0 ? 'OK  ' : 'FAIL';
  if (failures.length > 0) failed += 1;

  console.log(`${verdict} ${scenario.id}  ${scenario.what}`);
  console.log(
    `       fault=${scenario.fault} tool=${scenario.tool} requests=${outcome.requests} elapsed=${outcome.elapsedMs}ms`,
  );
  console.log(`       ${outcome.text.replace(/\n/g, ' ').slice(0, 220)}`);
  for (const failure of failures) console.log(`       -> ${failure}`);
  console.log();
}

console.log(
  failed === 0
    ? `All ${chosen.length} scenarios passed.${skipSlow ? ' (deadline scenario skipped)' : ''}`
    : `${failed} of ${chosen.length} scenarios failed.`,
);
process.exit(failed === 0 ? 0 : 1);
