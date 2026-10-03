#!/usr/bin/env node
// Measures what an MCP client actually hands the model: a fake stdio server
// exposes one tool whose description and `params` property description carry
// marker tokens at known offsets, then `claude -p` reports which markers it can
// see. Re-run before raising VERIFIED_SCHEMA_DESCRIPTION_LENGTH
// (src/routing/proxy-schema.ts) or after a Claude Code upgrade; rationale in
// docs/decisions/proxy-schema-surface.md.
//
//   node scripts/probe-mcp-description-cap.mjs [--length 15000] [--model <id>]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const argValue = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};

const length = Number(argValue('--length', '15000'));
// A NaN or tiny length would pad nothing and report a false OK.
if (!Number.isInteger(length) || length < 100) {
  console.error('--length must be an integer of at least 100');
  process.exit(2);
}
// Whole words only: a word cut mid-way reads to the model like a truncation.
const pad = (n) => 'filler text '.repeat(Math.max(1, Math.round(n / 12))).trim();
const MARKERS = {
  description: ['DESC_START_A1', 'DESC_END_Z9'],
  params: ['PARAM_START_B2', 'PARAM_MIDDLE_C3', 'PARAM_END_Y8'],
};

const serve = () => {
  const half = Math.floor(length / 2);
  const tool = {
    name: 'probe',
    description: `Probe tool. ${MARKERS.description[0]}. ${pad(3000)} ${MARKERS.description[1]}.`,
    inputSchema: {
      type: 'object',
      properties: {
        params: {
          type: 'object',
          description: `${MARKERS.params[0]}. ${pad(half)} ${MARKERS.params[1]}. ${pad(length - half)} ${MARKERS.params[2]}.`,
        },
      },
    },
  };
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'probe', version: '1' },
        },
      });
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [tool] } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  });
};

const probe = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-probe-'));
  const config = join(dir, 'mcp.json');
  const self = fileURLToPath(import.meta.url);
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        probe: { command: process.execPath, args: [self, '--serve', '--length', String(length)] },
      },
    }),
  );
  // ToolSearch is allowed because a large schema can make Claude Code defer the
  // tool; loading it is part of what a real session does.
  const prompt =
    "If mcp__probe__probe's schema is not loaded, load it with ToolSearch (select:mcp__probe__probe). Never call mcp__probe__probe itself. Then list every token matching [A-Z]+_[A-Z0-9_]+ you can literally see in its description and input schema, grouped by location, and say whether any text shows a truncation marker. Do not guess.";
  const model = argValue('--model', 'claude-haiku-4-5-20251001');
  const run = spawnSync(
    'claude',
    [
      '-p',
      prompt,
      '--mcp-config',
      config,
      '--strict-mcp-config',
      '--model',
      model,
      '--allowedTools',
      'ToolSearch',
    ],
    { cwd: dir, encoding: 'utf8', input: '', timeout: 180_000 },
  );
  rmSync(dir, { recursive: true, force: true });
  if (run.error || run.status !== 0) {
    console.error(run.error?.message ?? run.stderr);
    process.exit(1);
  }
  const answer = run.stdout;
  console.log(answer.trim(), '\n');
  console.log(`params description length: ${length}`);
  for (const [where, markers] of Object.entries(MARKERS)) {
    for (const marker of markers) {
      console.log(`${answer.includes(marker) ? 'seen   ' : 'MISSING'} ${where}: ${marker}`);
    }
  }
  const paramsWhole = MARKERS.params.every((marker) => answer.includes(marker));
  console.log(
    paramsWhole
      ? `\nOK: a ${length}-char property description reached the model whole.`
      : '\nFAIL: the property description was cut; do not raise the verified length.',
  );
  process.exit(paramsWhole ? 0 : 1);
};

if (process.argv.includes('--serve')) serve();
else probe();
