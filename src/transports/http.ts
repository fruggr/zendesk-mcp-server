import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from '../config';
import { getOAuthUrls } from '../constants';
import { createMcpServer } from '../server';
import { type Logger, silentLogger } from '../utils/logger';

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '*']);
const TRAILING_SLASHES = /\/+$/;

// Default CORS allowlist: the major web MCP clients that work today via
// Custom Connector UIs. Native clients (Claude Desktop, Claude Code CLI,
// Cursor, VS Code, Zed) send no Origin header — they're unaffected. Extend
// the list with --cors-origin / CORS_ORIGIN per deployment.
//
// Ordered by current usage share (ChatGPT first). Update over time as the
// MCP client landscape evolves.
export const DEFAULT_BROWSER_MCP_CLIENT_ORIGINS: readonly string[] = [
  'https://chatgpt.com',
  'https://chat.openai.com',
  'https://claude.ai',
  'https://gemini.google.com',
  'https://copilot.microsoft.com',
  'https://www.perplexity.ai',
  'https://chat.mistral.ai',
  'https://grok.com',
];

// Methods + headers exposed across CORS for the /mcp endpoint. Headers list
// covers what the SDK's StreamableHTTPClientTransport sets plus the bearer.
const CORS_ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS';
const CORS_ALLOWED_HEADERS =
  'Authorization, Content-Type, Accept, mcp-session-id, mcp-protocol-version, last-event-id';
// Clients need to read the session ID from the response to send it on
// subsequent requests; without this header they can't.
const CORS_EXPOSE_HEADERS = 'mcp-session-id';
const CORS_MAX_AGE = '600';

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Returns the origin string to reflect in `Access-Control-Allow-Origin`, or
 * `undefined` if the origin is not allowed.
 *
 * The returned value is **never the raw `Origin` request header**. It comes
 * from one of three sanitization points:
 *
 *   1. An entry of the hardcoded `DEFAULT_BROWSER_MCP_CLIENT_ORIGINS` array.
 *   2. An entry of the operator-configured `extraOrigins` array.
 *   3. A loopback origin rebuilt from validated URL components after the
 *      hostname has been allowlisted against `LOCALHOST_HOSTNAMES`.
 *
 * This shape keeps the dataflow from request header to response header
 * gated by a constant allowlist, which is the pattern CodeQL's
 * `js/cors-misconfiguration-for-credentials` rule recognises as safe when
 * combined with `Access-Control-Allow-Credentials: true`.
 */
export const resolveAllowedOrigin = (
  origin: string,
  extraOrigins: readonly string[] | undefined,
): string | undefined => {
  const defaultMatch = DEFAULT_BROWSER_MCP_CLIENT_ORIGINS.find((entry) => entry === origin);
  if (defaultMatch) return defaultMatch;

  const extraMatch = extraOrigins?.find((entry) => entry === origin);
  if (extraMatch) return extraMatch;

  // Loopback on any port: parse, allowlist the hostname, then rebuild from
  // the validated parts. The output never includes raw header bytes.
  try {
    const url = new URL(origin);
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return undefined;
    if (!LOCALHOST_HOSTNAMES.has(url.hostname)) return undefined;
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return `${url.protocol}//${url.hostname}:${port}`;
  } catch {
    return undefined;
  }
};

const applyCorsHeaders = (
  req: IncomingMessage,
  res: ServerResponse,
  extraOrigins: readonly string[],
): void => {
  const requestOrigin = req.headers['origin'];
  if (typeof requestOrigin !== 'string' || requestOrigin.length === 0) return;

  // The value passed to setHeader is the matched entry from the constant
  // allowlist (or a loopback origin rebuilt from validated URL parts) —
  // never the raw request header. This satisfies CodeQL's
  // `js/cors-misconfiguration-for-credentials` rule when combined with
  // Access-Control-Allow-Credentials: true.
  const allowedOrigin = resolveAllowedOrigin(requestOrigin, extraOrigins);
  if (!allowedOrigin) return;

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
};

const handleCorsPreflight = (
  req: IncomingMessage,
  res: ServerResponse,
  extraOrigins: readonly string[],
): boolean => {
  if (req.method !== 'OPTIONS') return false;
  applyCorsHeaders(req, res, extraOrigins);
  // Preflight needs Allow-Methods and Allow-Headers in addition to the basic
  // CORS headers; if the origin isn't allowlisted, applyCorsHeaders is a
  // no-op and we still 204 (the browser blocks based on missing ACAO).
  if (res.getHeader('Access-Control-Allow-Origin')) {
    res.setHeader('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
    res.setHeader('Access-Control-Max-Age', CORS_MAX_AGE);
  }
  res.writeHead(204);
  res.end();
  return true;
};

// Build the canonical `resource` URL we advertise in the OAuth metadata.
// Precedence:
//   1. Explicit --public-url / PUBLIC_URL (operators behind a reverse proxy
//      must set this; Azure App Service: PUBLIC_URL="https://${WEBSITE_HOSTNAME}").
//   2. host:port when host is a real, routable hostname or IP (not the bind
//      wildcard 0.0.0.0 / :: / unspecified).
//   3. Fallback to host:port + warning. Clients following RFC 8707 strictly
//      will reject this resource identifier, so log a clear warning so the
//      operator knows to set PUBLIC_URL.
export const resolveResourceUrl = (config: Config, logger: Logger = silentLogger): string => {
  if (config.publicUrl) return config.publicUrl.replace(TRAILING_SLASHES, '');
  if (!WILDCARD_HOSTS.has(config.host)) {
    return `http://${config.host}:${config.port}`;
  }
  logger.warn('public_url_unset', {
    host: config.host,
    advertised: `http://${config.host}:${config.port}`,
    hint:
      'OAuth discovery will advertise a non-routable resource identifier and spec-compliant ' +
      'MCP clients may refuse the connection. Set PUBLIC_URL (or --public-url) to the URL ' +
      'clients use to reach this server (e.g. https://your-host.example.com).',
  });
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

export const buildOAuthMetadata = (
  config: Config,
  logger: Logger = silentLogger,
): OAuthMetadata => {
  const { authorizeUrl, tokenUrl } = getOAuthUrls(config.subdomain);
  const issuer = `https://${config.subdomain}.zendesk.com`;
  const resource = resolveResourceUrl(config, logger);
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

// Single construction point for JSON-RPC-shaped HTTP errors so the envelope
// ({ error, id: null, jsonrpc }) can't drift between the 4xx/5xx paths.
const sendJsonRpcError = (
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ error: { code, message }, id: null, jsonrpc: '2.0' }));
};

// Terminate a request whose handler threw. Once headers are on the wire,
// appending a JSON error mid-stream would corrupt the body, so the response is
// simply closed instead.
const failRequest = (res: ServerResponse, err: unknown): void => {
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  if (!res.headersSent) {
    sendJsonRpcError(res, 500, -32603, message);
    return;
  }
  if (!res.writableEnded) res.end();
};

const sendUnauthorized = (res: ServerResponse, resource: string): void => {
  // RFC 6750 + MCP 2025-06-18: the WWW-Authenticate header points the client
  // at the resource metadata that bootstraps the OAuth discovery flow.
  const wwwAuthenticate = `Bearer resource_metadata="${resource}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${MISSING_BEARER_MESSAGE}"`;
  sendJsonRpcError(res, 401, -32000, MISSING_BEARER_MESSAGE, {
    'WWW-Authenticate': wwwAuthenticate,
  });
};

interface Session {
  transport: StreamableHTTPServerTransport;
  /**
   * Latest bearer presented for this session. Tool calls read through this
   * object so a client that refreshes its Zendesk token mid-session has the
   * fresh token used on the next call.
   */
  auth: { bearer: string };
  /** Epoch ms of the last request routed to this session (idle eviction). */
  lastActivityAt: number;
  close(): Promise<void>;
}

// JSON-RPC tool calls are small; this is a generous ceiling that exists only
// so a client can't stream an unbounded body into server memory.
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; rpcCode: number; message: string };

// Read and parse the request body. The SDK transport could parse the stream
// itself, but it neither caps the body size nor maps parse failures to the
// right HTTP status — buffering here keeps both concerns in one place.
const readJsonBody = (req: IncomingMessage, maxBodyBytes: number): Promise<BodyResult> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        req.removeAllListeners('data');
        settle({
          ok: false,
          status: 413,
          rpcCode: -32600,
          message: `Request body exceeds ${maxBodyBytes} bytes.`,
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        settle({ ok: true, value: undefined });
        return;
      }
      try {
        settle({ ok: true, value: JSON.parse(raw) });
      } catch {
        settle({
          ok: false,
          status: 400,
          rpcCode: -32700,
          message: 'Parse error: request body is not valid JSON.',
        });
      }
    });
    req.on('error', () =>
      settle({
        ok: false,
        status: 400,
        rpcCode: -32600,
        message: 'Request body could not be read.',
      }),
    );
  });

const respondBodyError = (
  req: IncomingMessage,
  res: ServerResponse,
  failure: Extract<BodyResult, { ok: false }>,
): void => {
  const headers = failure.status === 413 ? { Connection: 'close' } : {};
  sendJsonRpcError(res, failure.status, failure.rpcCode, failure.message, headers);
  if (failure.status === 413) {
    // The client may still be mid-upload with the request stream paused
    // (readJsonBody dropped its listeners at the cap). Left alone, the
    // connection wedges: the client blocks on backpressure and
    // httpServer.close() waits on the socket forever. Drop it as soon as the
    // 413 has flushed.
    if (res.writableFinished) req.destroy();
    else res.once('finish', () => req.destroy());
  }
};

// A client that vanishes without DELETEing its session would otherwise leak a
// McpServer + bearer forever (the SDK only fires onclose on an explicit
// DELETE). A periodic sweep closes sessions with no traffic for this long;
// well-behaved clients simply re-initialize on their next request.
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;

export interface HttpServerHandle {
  /** Actual bound port (resolved when listen completes — useful for port:0 tests). */
  port: number;
  /** Stop the HTTP server and tear down every active MCP session. */
  close(): Promise<void>;
}

export interface HttpTransportOptions {
  /** Idle-session eviction timeout override (tests). */
  sessionIdleTimeoutMs?: number;
  /** Idle-session sweep interval override (tests). */
  sweepIntervalMs?: number;
  /** Request body cap override (tests use a small cap to stay cheap). */
  maxBodyBytes?: number;
}

export const startHttpTransport = async (
  config: Config,
  logger: Logger = silentLogger,
  options: HttpTransportOptions = {},
): Promise<HttpServerHandle> => {
  const metadata = buildOAuthMetadata(config, logger);
  const sessions = new Map<string, Session>();
  const idleTimeoutMs = options.sessionIdleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;

  // Route a request onto an already-established session, adopting the presented
  // bearer (clients may have refreshed their Zendesk token mid-session).
  // Returns false when the id names no live session, so the caller falls
  // through to initialization; true means the response was already handled.
  const dispatchToSession = async (
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    bearer: string,
  ): Promise<boolean> => {
    const session = sessions.get(sessionId);
    if (!session) return false;

    session.auth.bearer = bearer;
    session.lastActivityAt = Date.now();
    const body =
      req.method === 'POST'
        ? await readJsonBody(req, maxBodyBytes)
        : ({ ok: true, value: undefined } as const);
    if (!body.ok) {
      respondBodyError(req, res, body);
      return true;
    }
    await session.transport.handleRequest(req, res, body.value);
    return true;
  };

  const handleMcpRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // MCP 2025-06-18: the Authorization header is validated on EVERY request,
    // not only at session initialization — a session id alone is not a
    // credential. An unauthenticated request gets a 401 + WWW-Authenticate
    // that bootstraps the OAuth flow on the client side.
    const bearer = extractBearer(req);
    if (!bearer) {
      sendUnauthorized(res, metadata.protectedResource.resource);
      return;
    }

    const sessionId =
      typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;

    if (sessionId && (await dispatchToSession(req, res, sessionId, bearer))) return;

    if (req.method !== 'POST') {
      // Non-POST without a session ID can't initialize a new session.
      sendJsonRpcError(res, 400, -32000, 'No active session; initialize via POST first.');
      return;
    }

    const body = await readJsonBody(req, maxBodyBytes);
    if (!body.ok) {
      respondBodyError(req, res, body);
      return;
    }

    // New session: the bearer is held in a per-session mutable cell read by
    // the per-session McpServer's token source — no async-local storage
    // needed because each session has its own server instance.
    const auth = { bearer };
    const server = createMcpServer(config, () => auth.bearer, logger);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newId) => {
        sessions.set(newId, {
          transport,
          auth,
          lastActivityAt: Date.now(),
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
    await transport.handleRequest(req, res, body.value);
  };

  // GET endpoints answered straight from static metadata — the two RFC 9728 /
  // RFC 8414 discovery documents plus the health probe. Everything else routes
  // to /mcp or 404s.
  const staticGetRoutes: Record<string, unknown> = {
    '/.well-known/oauth-protected-resource': metadata.protectedResource,
    '/.well-known/oauth-authorization-server': metadata.authorizationServer,
    '/healthz': { status: 'ok', subdomain: config.subdomain },
  };

  const requestListener = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // CORS preflight is short-circuited before routing; for actual requests
      // we attach the allow-headers BEFORE we dispatch so they ride along
      // with the response regardless of which handler ends it.
      if (handleCorsPreflight(req, res, config.corsOrigins)) return;
      applyCorsHeaders(req, res, config.corsOrigins);

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      const staticRoute = req.method === 'GET' ? staticGetRoutes[url.pathname] : undefined;
      if (staticRoute) {
        sendJson(res, 200, staticRoute);
        return;
      }
      if (url.pathname === '/mcp') {
        await handleMcpRequest(req, res);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));
    } catch (err) {
      failRequest(res, err);
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
  logger.info('http_transport_ready', { host: config.host, port: boundPort });

  const sweepIdleSessions = async (): Promise<void> => {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const [id, session] of sessions) {
      if (session.lastActivityAt > cutoff) continue;
      sessions.delete(id);
      try {
        await session.close();
      } catch (err) {
        logger.warn('session_close_failed', {
          sessionId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  const sweeper = setInterval(
    () => void sweepIdleSessions(),
    options.sweepIntervalMs ?? SESSION_SWEEP_INTERVAL_MS,
  );
  // The sweeper must never keep the process alive on its own.
  sweeper.unref();

  return {
    port: boundPort,
    close: async () => {
      clearInterval(sweeper);
      await Promise.all([...sessions.values()].map((session) => session.close()));
      sessions.clear();
      // server.close() waits for every connection to drain; a wedged or
      // keep-alive socket would stall shutdown forever. Sessions are already
      // closed at this point, so dropping the remaining sockets is safe.
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
};
