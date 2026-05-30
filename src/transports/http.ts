import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from '../config';
import { getOAuthUrls } from '../constants';
import { createMcpServer } from '../server';

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '*']);

// Build the canonical `resource` URL we advertise in the OAuth metadata.
// Precedence:
//   1. Explicit --public-url / PUBLIC_URL (operators behind a reverse proxy
//      must set this; Azure App Service: PUBLIC_URL="https://${WEBSITE_HOSTNAME}").
//   2. host:port when host is a real, routable hostname or IP (not the bind
//      wildcard 0.0.0.0 / :: / unspecified).
//   3. Fallback to host:port + warning. Clients following RFC 8707 strictly
//      will reject this resource identifier, so log a clear warning so the
//      operator knows to set PUBLIC_URL.
export const resolveResourceUrl = (config: Config): string => {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
  if (!WILDCARD_HOSTS.has(config.host)) {
    return `http://${config.host}:${config.port}`;
  }
  console.error(
    `[zendesk-mcp-server] WARNING: HOST=${config.host} but PUBLIC_URL is unset. ` +
      `OAuth discovery will advertise http://${config.host}:${config.port} as the ` +
      `resource identifier, which is not routable from external clients and may ` +
      `cause spec-compliant MCP clients to refuse the connection. Set PUBLIC_URL ` +
      `(or --public-url) to the URL clients use to reach this server (e.g. ` +
      `https://your-host.example.com).`,
  );
  return `http://${config.host}:${config.port}`;
};

// Error message must stay ASCII-only: it gets embedded in the WWW-Authenticate
// response header on 401, and node:http's setHeader rejects non-ASCII bytes
// with ERR_INVALID_CHAR (which would surface as a 500 instead of the
// spec-required 401).
const MISSING_BEARER_MESSAGE =
  'Missing Authorization: Bearer <zendesk-oauth-token> header. ' +
  'HTTP mode requires per-user OAuth 2.1 PKCE - obtain a token from Zendesk via your MCP client.';

export const extractBearer = (request: IncomingMessage): string | undefined => {
  const header = request.headers['authorization'];
  if (typeof header !== 'string') return undefined;
  if (!header.toLowerCase().startsWith('bearer ')) return undefined;
  return header.slice('bearer '.length).trim();
};

interface OAuthMetadata {
  protectedResource: {
    authorization_servers: string[];
    resource: string;
    bearer_methods_supported: string[];
    scopes_supported: string[];
  };
  authorizationServer: {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    response_types_supported: string[];
    grant_types_supported: string[];
    code_challenge_methods_supported: string[];
    token_endpoint_auth_methods_supported: string[];
    scopes_supported: string[];
  };
}

export const buildOAuthMetadata = (config: Config): OAuthMetadata => {
  const { authorizeUrl, tokenUrl } = getOAuthUrls(config.subdomain);
  const issuer = `https://${config.subdomain}.zendesk.com`;
  const resource = resolveResourceUrl(config);
  return {
    protectedResource: {
      authorization_servers: [issuer],
      resource,
      bearer_methods_supported: ['header'],
      scopes_supported: ['read', 'write'],
    },
    authorizationServer: {
      issuer,
      authorization_endpoint: authorizeUrl,
      token_endpoint: tokenUrl,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['read', 'write'],
    },
  };
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const sendUnauthorized = (res: ServerResponse, resource: string): void => {
  // RFC 6750 + MCP 2025-06-18: the WWW-Authenticate header points the client
  // at the resource metadata that bootstraps the OAuth discovery flow.
  const wwwAuthenticate = `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${MISSING_BEARER_MESSAGE}"`;
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': wwwAuthenticate,
  });
  res.end(
    JSON.stringify({
      error: { code: -32000, message: MISSING_BEARER_MESSAGE },
      id: null,
      jsonrpc: '2.0',
    }),
  );
};

interface Session {
  transport: StreamableHTTPServerTransport;
  close(): Promise<void>;
}

// Read the request body into a string. The SDK transport expects a parsed
// body or will parse from the stream itself; we go through a buffer to keep
// the JSON-RPC dispatch deterministic.
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

export interface HttpServerHandle {
  /** Actual bound port (resolved when listen completes — useful for port:0 tests). */
  port: number;
  /** Stop the HTTP server and tear down every active MCP session. */
  close(): Promise<void>;
}

export const startHttpTransport = async (config: Config): Promise<HttpServerHandle> => {
  const metadata = buildOAuthMetadata(config);
  const sessions = new Map<string, Session>();

  const handleMcpRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId =
      typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;

    // Existing session: route the request to its transport.
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      // biome-ignore lint/style/noNonNullAssertion: just checked has() above
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const parsed = body ? JSON.parse(body) : undefined;
      await session!.transport.handleRequest(req, res, parsed);
      return;
    }

    // New session: an unauthenticated request gets a 401 + WWW-Authenticate
    // that bootstraps the OAuth flow on the client side. The bearer is
    // captured here and passed to the per-session McpServer as the token
    // source for every tool call on that session — no async-local storage
    // needed because each session has its own server instance.
    const bearer = extractBearer(req);
    if (!bearer) {
      sendUnauthorized(res, metadata.protectedResource.resource);
      return;
    }

    if (req.method !== 'POST') {
      // Non-POST without a session ID can't initialize a new session.
      sendJson(res, 400, {
        error: { code: -32000, message: 'No active session; initialize via POST first.' },
        id: null,
        jsonrpc: '2.0',
      });
      return;
    }

    const body = await readBody(req);
    const parsed = body ? JSON.parse(body) : undefined;

    const { server } = createMcpServer(config, () => bearer);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newId) => {
        sessions.set(newId, {
          transport,
          close: async () => {
            await transport.close();
            await server.close();
          },
        });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    // The SDK's Transport interface uses `onclose?: () => void` which conflicts
    // with the concrete transport's class member typing under
    // exactOptionalPropertyTypes — the runtime contract is identical, this is
    // purely a type-system seam.
    // biome-ignore lint/suspicious/noExplicitAny: SDK type seam, see above
    await server.connect(transport as any);
    await transport.handleRequest(req, res, parsed);
  };

  const requestListener = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (url.pathname === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
        sendJson(res, 200, metadata.protectedResource);
        return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
        sendJson(res, 200, metadata.authorizationServer);
        return;
      }
      if (url.pathname === '/healthz' && req.method === 'GET') {
        sendJson(res, 200, { status: 'ok', subdomain: config.subdomain });
        return;
      }
      if (url.pathname === '/mcp') {
        await handleMcpRequest(req, res);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(
          JSON.stringify({
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : 'Internal Server Error',
            },
            id: null,
            jsonrpc: '2.0',
          }),
        );
      }
    }
  };

  const httpServer: Server = createServer((req, res) => {
    void requestListener(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : config.port;
  console.error(`Zendesk MCP server running via http on ${config.host}:${boundPort}`);

  return {
    port: boundPort,
    close: async () => {
      for (const session of sessions.values()) await session.close();
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
};
