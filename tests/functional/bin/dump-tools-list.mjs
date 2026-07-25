#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const serverEntry = resolve(repoRoot, 'dist', 'index.js');

const MODES = new Set(['single', 'namespace', 'all']);

const parseArgs = (argv) => {
  const out = { mode: undefined, readOnly: false, namespaces: [], tools: [] };
  const requireValue = (flag, value) => {
    if (value === undefined) {
      console.error(`Missing value for ${flag}`);
      process.exit(2);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') out.mode = requireValue('--mode', argv[++i]);
    else if (a === '--read-only') out.readOnly = true;
    else if (a === '--namespace') out.namespaces.push(requireValue('--namespace', argv[++i]));
    else if (a === '--tool') out.tools.push(requireValue('--tool', argv[++i]));
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!out.mode) {
    console.error('Missing --mode <single|namespace|all>');
    process.exit(2);
  }
  if (!MODES.has(out.mode)) {
    console.error(`Invalid --mode "${out.mode}". Expected one of: single, namespace, all.`);
    process.exit(2);
  }
  return out;
};

const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

const subdomain = process.env.ZENDESK_SUBDOMAIN;
if (!subdomain) {
  die(
    'ZENDESK_SUBDOMAIN is not set. See "Prerequisites (executor side)" in ' +
      'tests/functional/README.md for how to configure the reference Zendesk ' +
      'instance (fruggr) locally.',
  );
}
if (!existsSync(serverEntry)) {
  die(`Server bundle not found at ${serverEntry}. Run "pnpm build" first.`);
}

const opts = parseArgs(process.argv.slice(2));

const serverArgs = [serverEntry, subdomain, '--mode', opts.mode];
if (opts.readOnly) serverArgs.push('--read-only');
for (const ns of opts.namespaces) serverArgs.push('--namespace', ns);
for (const t of opts.tools) serverArgs.push('--tool', t);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: serverArgs,
  env: process.env,
  stderr: 'inherit',
});

const client = new Client({ name: 'functional-test-dump', version: '0.0.0' });

const timeout = setTimeout(() => {
  die('Timed out after 30s waiting for tools/list.');
}, 30_000);

try {
  await client.connect(transport);
  const result = await client.listTools();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  clearTimeout(timeout);
  await client.close().catch(() => {});
}
