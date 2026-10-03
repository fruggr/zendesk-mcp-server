import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { bypass, http } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { signInWithDcr } from '../integration/oauth-client';
import { localServerPassthrough } from '../msw-handlers';
import { mswServer } from '../setup';

/**
 * Runs what ships: `dist/index.js` in its own process, with the Zendesk mock
 * preloaded into it (zendesk-upstream.ts). Nothing from src/ is imported, so a
 * module the bundle failed to inline, or an interop the bundler got wrong,
 * fails here rather than in a user's install. Needs `pnpm build` first
 * (`pnpm test:bundle` does both).
 */

const ENTRY = resolve('dist/index.js');
const NODE_ARGS = ['--import', 'tsx', '--import', resolve('tests/bundle/zendesk-upstream.ts')];
const MARKER_TIMEOUT_MS = 20_000;

const textOf = (result: { content?: unknown }): string =>
  ((result.content ?? []) as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? '')
    .join('\n');

const freePort = (): Promise<number> =>
  new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });

interface Started {
  proc: ChildProcess;
  relayPort: number;
}

const startHttpServer = (port: number, env: Record<string, string>): Promise<Started> =>
  new Promise((done, fail) => {
    const proc = spawn(
      process.execPath,
      [
        ...NODE_ARGS,
        ENTRY,
        'testsubdomain',
        '--transport',
        'http',
        '--host',
        '127.0.0.1',
        '--port',
        `${port}`,
        '--mode',
        'all',
      ],
      { env: { ...process.env, LOG_LEVEL: 'info', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    const timer = setTimeout(
      () => fail(new Error(`server did not start:\n${output}`)),
      MARKER_TIMEOUT_MS,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const relay = /zendesk_relay_ready port=(\d+)/.exec(output);
      if (relay && output.includes('http_transport_ready')) {
        clearTimeout(timer);
        done({ proc, relayPort: Number(relay[1]) });
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.once('exit', (code) => fail(new Error(`server exited (${code}):\n${output}`)));
  });

const stop = async (proc: ChildProcess | undefined): Promise<void> => {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((done) => proc.once('exit', done));
  proc.kill('SIGTERM');
  await exited;
};

// Browser hops to Zendesk go to the mock living in the server process.
const relayZendesk = (relayPort: number) =>
  http.get('https://testsubdomain.zendesk.com/oauth/authorizations/new', async ({ request }) => {
    const { pathname, search } = new URL(request.url);
    const target = `http://127.0.0.1:${relayPort}${pathname}${search}`;
    return fetch(bypass(new Request(target, { redirect: 'manual' })));
  });

const connect = async (baseUrl: string, accessToken: string): Promise<Client> => {
  const client = new Client({ name: 'dist-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
  return client;
};

let workDir: string;

beforeAll(() => {
  if (!existsSync(ENTRY)) throw new Error('dist/index.js is missing: run `pnpm build` first.');
  workDir = mkdtempSync(join(tmpdir(), 'zendesk-mcp-dist-'));
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe('dist bundle over stdio', () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it('lists the tools and calls one against Zendesk', async () => {
    const tokenFile = join(workDir, 'stdio-token.json');
    writeFileSync(tokenFile, JSON.stringify({ accessToken: 'zd-test', scope: 'read write' }));
    client = new Client({ name: 'dist-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [...NODE_ARGS, ENTRY, 'testsubdomain', '--mode', 'all'],
        env: { ...(process.env as Record<string, string>), OAUTH_TOKEN_FILE: tokenFile },
        stderr: 'ignore',
      }),
    );

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('get_ticket');
    const result = await client.callTool({ name: 'list_sla_policies', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('SLA contractuels fruggr - Bugs/Incidents');
  });
});

describe('dist bundle over HTTP', () => {
  let server: ChildProcess | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await stop(server);
    server = undefined;
  });

  it('signs a client in, serves a tool, and keeps the session across a restart', async () => {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const storePath = join(workDir, 'oauth-store.json');
    const env = {
      OAUTH_MASTER_SECRET: Buffer.alloc(32, 8).toString('base64'),
      OAUTH_STORE: pathToFileURL(storePath).href,
    };

    const first = await startHttpServer(port, env);
    server = first.proc;
    mswServer.use(localServerPassthrough, relayZendesk(first.relayPort));
    const { tokens } = await signInWithDcr(baseUrl);
    const accessToken = tokens.body.access_token ?? '';
    expect(accessToken).not.toBe('');

    client = await connect(baseUrl, accessToken);
    const before = await client.callTool({ name: 'list_sla_policies', arguments: {} });
    expect(textOf(before)).toContain('SLA contractuels fruggr - Bugs/Incidents');
    await client.close();
    client = undefined;
    expect((statSync(storePath).mode % 0o1000).toString(8)).toBe('600');

    await stop(server);
    server = (await startHttpServer(port, env)).proc;

    client = await connect(baseUrl, accessToken);
    const after = await client.callTool({ name: 'list_sla_policies', arguments: {} });
    expect(after.isError).toBeFalsy();
    expect(textOf(after)).toContain('SLA contractuels fruggr - Bugs/Incidents');
  });
});
