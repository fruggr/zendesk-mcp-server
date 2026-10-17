#!/usr/bin/env tsx
/**
 * Live driver for the Zendesk MCP server — boots the *current source tree* and
 * talks to it through a real MCP client over an in-memory transport, exactly
 * like `tests/integration` but interactive and against a live config.
 *
 * It does NOT register itself as an MCP server (no `.mcp.json` needed); it is a
 * one-shot client you can run from any branch to exercise tools live.
 *
 * Usage:
 *   pnpm tsx scripts/mcp-live.ts list                       # list exposed tools + resources
 *   pnpm tsx scripts/mcp-live.ts call <tool> '<json-params>' # call one tool
 *   pnpm tsx scripts/mcp-live.ts read <resource-uri>         # read one resource
 *
 * Protocol era (`--era`, default 2025): the client pins 2026-07-28 with
 * `--era 2026`, negotiates with `--era auto`, and prints the negotiated revision
 * to stderr. The in-process server goes through the same `startStdioTransport`
 * the binary uses:
 *   pnpm tsx scripts/mcp-live.ts list --era 2026 -- --mode all
 *
 * A running HTTP server instead (`--url`): signs in through the server's own
 * OAuth flow (DCR + PKCE; prints the URL to open, receives the code on
 * http://127.0.0.1:27440/callback, MCP_LIVE_CALLBACK_PORT to change it) and
 * caches the tokens in a 0600 file under the config dir, so later runs reuse
 * them. `--read-only-scope` asks for `read` only; `probe-unauth` sends a 2026
 * request without a token and prints the status and WWW-Authenticate:
 *   pnpm tsx scripts/mcp-live.ts list --url http://localhost:3000/mcp --era 2026
 *   pnpm tsx scripts/mcp-live.ts probe-unauth --url http://localhost:3000/mcp
 *
 * Anything after `--` is forwarded to the server config parser, so the full CLI
 * surface (`--mode`, `--namespace`, `--read-only`, `--tool`) is available:
 *   pnpm tsx scripts/mcp-live.ts list -- --mode namespace
 *   pnpm tsx scripts/mcp-live.ts call get_current_user '{}' -- --mode all
 *   pnpm tsx scripts/mcp-live.ts read zendesk-hc://topology -- --mode all
 *
 * Auth: this server is OAuth 2.1 PKCE only, and the browser flow can't run
 * headless. So `list` / schema validation work credential-free, and a real
 * `call` or `read` reads a pre-obtained OAuth access token from
 * ZENDESK_OAUTH_TOKEN and sends it as a Bearer. Grab one via the normal OAuth
 * flow (e.g. in a local session) and export it before calling.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import {
  Client,
  type ClientOptions,
  InMemoryTransport,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { configDir } from '../src/auth/token-persistence';
import { loadConfig, VALUE_FLAG_NAMES } from '../src/config';
import { createMcpServer } from '../src/server';
import { startStdioTransport } from '../src/transports/stdio';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep === -1 ? argv : argv.slice(0, sep);
const configArgs = sep === -1 ? [] : argv.slice(sep + 1);

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

// Own flags, removed from the positional arguments as they are read.
const takeValue = (name: string): string | undefined => {
  const at = own.indexOf(name);
  if (at === -1) return undefined;
  const [, value] = own.splice(at, 2);
  if (value === undefined) fail(`${name} needs a value`);
  return value;
};
const takeSwitch = (name: string): boolean => {
  const at = own.indexOf(name);
  if (at !== -1) own.splice(at, 1);
  return at !== -1;
};
const era = takeValue('--era') ?? '2025';
if (!['2025', '2026', 'auto'].includes(era)) fail('--era takes 2025, 2026 or auto');
const url = takeValue('--url');
const readOnlyScope = takeSwitch('--read-only-scope');

const [command, toolName, rawParams] = own;

const MODERN_REVISION = '2026-07-28';
const CLIENT_OPTIONS: Record<string, ClientOptions> = {
  '2025': {},
  '2026': { versionNegotiation: { mode: { pin: MODERN_REVISION } } },
  auto: { versionNegotiation: { mode: 'auto' } },
};
const clientOptions = CLIENT_OPTIONS[era] ?? {};

// `subdomain` is required by the config schema, but `list` and arg validation
// never touch Zendesk — so when no subdomain is provided (env or positional
// arg), fall back to a placeholder. This keeps credential-free inspection
// working; a real `call` still needs a real subdomain + token.
// Skip values that follow a value-taking flag (e.g. `all` in `--mode all`),
// otherwise the placeholder is wrongly skipped. The flag list comes from
// `src/config.ts`, so it cannot drift from the parser's own view of it.
const hasPositionalSubdomain = configArgs.some((arg, i) => {
  if (arg.startsWith('-')) return false;
  const prev = configArgs[i - 1];
  return !(prev && VALUE_FLAG_NAMES.has(prev));
});
if (!process.env['ZENDESK_SUBDOMAIN'] && !hasPositionalSubdomain) {
  process.env['ZENDESK_SUBDOMAIN'] = 'mcp-live-placeholder';
}

const config = loadConfig(configArgs);

// OAuth is unusable headless, so a missing token only errors when a tool
// actually tries to reach Zendesk — `list` and arg validation still work
// without credentials. Throwing (rather than exiting) lets the MCP layer
// surface a clean tool error instead of killing the process.
const oauthToken = process.env['ZENDESK_OAUTH_TOKEN'];
const getToken = (): string => {
  if (oauthToken) return oauthToken;
  throw new Error(
    'Live calls need a Zendesk OAuth access token in ZENDESK_OAUTH_TOKEN ' +
      '(the browser PKCE flow cannot run headless here). ' +
      'Obtain one via the normal OAuth flow and export it, or use `list` which requires no token.',
  );
};

// An in-process server over the same stdio entry the binary uses.
const connectLocal = async (): Promise<{ client: Client; close: () => Promise<void> }> => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = startStdioTransport(
    ({ requestStateCodec }) =>
      createMcpServer(config, getToken, undefined, undefined, { requestStateCodec }),
    undefined,
    { transport: serverTransport },
  );
  const client = new Client({ name: 'mcp-live', version: '0.0.0' }, clientOptions);
  await client.connect(clientTransport);
  return { client, close: () => handle.close() };
};

const CALLBACK_PORT = Number(process.env['MCP_LIVE_CALLBACK_PORT'] ?? 27440);
const REDIRECT_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

/** The OAuth client state cached for one server URL. */
interface OAuthState {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  verifier?: string;
}

const oauthProvider = (serverUrl: string): OAuthClientProvider => {
  const key = createHash('sha256')
    .update(`${serverUrl} ${readOnlyScope}`)
    .digest('hex')
    .slice(0, 16);
  const file = join(configDir(), `mcp-live-${key}.json`);
  const load = (): OAuthState =>
    existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as OAuthState) : {};
  const save = (patch: OAuthState): void => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ ...load(), ...patch }), { mode: 0o600 });
  };
  return {
    get redirectUrl() {
      return REDIRECT_URL;
    },
    get clientMetadata() {
      return {
        client_name: 'mcp-live',
        redirect_uris: [REDIRECT_URL],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: readOnlyScope ? 'read offline_access' : 'read write offline_access',
      };
    },
    clientInformation: () => load().client,
    saveClientInformation: (client) => save({ client }),
    tokens: () => load().tokens,
    saveTokens: (tokens) => save({ tokens }),
    redirectToAuthorization: (authorizationUrl) => {
      console.error(`Open this URL to sign in, then come back:\n${authorizationUrl.href}`);
    },
    saveCodeVerifier: (verifier) => save({ verifier }),
    codeVerifier: () => load().verifier ?? fail('No PKCE verifier saved; run the command again.'),
  };
};

// Waits for the authorization server to redirect the browser to our callback.
const awaitCallback = (): Promise<URLSearchParams> =>
  new Promise((resolve) => {
    const server = createServer((req, res) => {
      const params = new URL(req.url ?? '/', REDIRECT_URL).searchParams;
      res.end('Signed in; you can close this tab.');
      server.close();
      resolve(params);
    });
    server.listen(CALLBACK_PORT, '127.0.0.1');
  });

const connectHttp = async (
  serverUrl: string,
): Promise<{ client: Client; close: () => Promise<void> }> => {
  const authProvider = oauthProvider(serverUrl);
  const attempt = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider });
    const client = new Client({ name: 'mcp-live', version: '0.0.0' }, clientOptions);
    await client.connect(transport);
    return { client, transport };
  };
  try {
    const { client } = await attempt();
    return { client, close: async () => undefined };
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    const callback = awaitCallback();
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider });
    await transport.finishAuth(await callback);
    const { client } = await attempt();
    return { client, close: async () => undefined };
  }
};

// A 2026-07-28 request with no token: what an unauthenticated client meets.
const probeUnauthenticated = async (serverUrl: string): Promise<void> => {
  const res = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MODERN_REVISION,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_REVISION } },
    }),
  });
  console.log(`status: ${res.status}`);
  console.log(`www-authenticate: ${res.headers.get('www-authenticate') ?? '(none)'}`);
};

const main = async (): Promise<void> => {
  if (command === 'probe-unauth') {
    if (!url) fail('Usage: mcp-live.ts probe-unauth --url <http://host/mcp>');
    await probeUnauthenticated(url as string);
    return;
  }
  const { client, close } = url ? await connectHttp(url) : await connectLocal();
  console.error(`negotiated protocol: ${client.getNegotiatedProtocolVersion() ?? 'unknown'}`);

  try {
    if (command === 'list' || command === undefined) {
      const { tools } = await client.listTools();
      console.log(`# ${tools.length} tool(s) in "${config.mode}" mode\n`);
      for (const tool of tools) {
        const firstLine = (tool.description ?? '').split('\n')[0];
        console.log(`- ${tool.name}: ${firstLine}`);
      }
      // Resources are only advertised when the server registers at least one
      // (e.g. the topology resource). In tool-only sessions (--no-topology, or a
      // namespace without resources) the capability is absent, so guard the call
      // to keep `list` working everywhere.
      if (client.getServerCapabilities()?.resources) {
        const { resources } = await client.listResources();
        console.log(`\n# ${resources.length} resource(s)\n`);
        for (const resource of resources) {
          console.log(`- ${resource.uri}: ${resource.description ?? resource.name}`);
        }
      }
      return;
    }

    if (command === 'read') {
      const uri = toolName;
      if (!uri) fail('Usage: mcp-live.ts read <resource-uri>');
      const result = await client.readResource({ uri: uri as string });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === 'call') {
      if (!toolName) fail("Usage: mcp-live.ts call <tool> ['<json-params>']");
      let args: Record<string, unknown> = {};
      if (rawParams) {
        try {
          args = JSON.parse(rawParams);
        } catch (error) {
          fail(`Invalid JSON params: ${(error as Error).message}`);
        }
      }
      const result = await client.callTool({ name: toolName as string, arguments: args });
      console.log(JSON.stringify(result, null, 2));
      if (result.isError) process.exitCode = 1;
      return;
    }

    fail(`Unknown command "${command}". Use "list", "call", "read" or "probe-unauth".`);
  } finally {
    await client.close();
    await close();
  }
};

main().catch((error) => {
  console.error('mcp-live failed:', error);
  process.exit(1);
});
