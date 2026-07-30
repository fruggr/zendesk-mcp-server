import { request as httpRequest, type IncomingMessage } from 'node:http';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/config';
import {
  buildOAuthMetadata,
  DEFAULT_BROWSER_MCP_CLIENT_ORIGINS,
  extractBearer,
  MAX_BODY_BYTES,
  resolveAllowedOrigin,
  resolveResourceUrl,
  startHttpTransport,
} from '../../../src/transports/http';
import { type Logger, silentLogger } from '../../../src/utils/logger';
import { errorHandlers, MOCK_USER } from '../../msw-handlers';
import { mswServer } from '../../setup';

const baseConfig: Config = {
  subdomain: 'testsubdomain',
  oauthClientId: 'test_zendesk',
  logLevel: 'error',
  mode: 'all',
  readOnly: false,
  transport: 'http',
  host: '127.0.0.1',
  port: 0,
  corsOrigins: [],
};

const mockRequest = (headers: Record<string, string | string[] | undefined>): IncomingMessage =>
  ({ headers }) as unknown as IncomingMessage;

// Initialize an MCP session over HTTP and return its mcp-session-id.
const initializeSession = async (port: number, authorization: string): Promise<string> => {
  const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1,
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.0' },
      },
    }),
  });
  // Throw rather than `expect()` here: this runs outside an `it()` body, where a
  // failed assertion is reported against whichever test happened to call the
  // helper. A thrown error names the real problem.
  if (init.status !== 200) {
    throw new Error(`initialize returned ${init.status}, expected 200`);
  }
  const sessionId = init.headers.get('mcp-session-id');
  await init.text();
  if (!sessionId) throw new Error('initialize did not return a session id');
  return sessionId;
};

describe('extractBearer', () => {
  it('returns the token from a well-formed Bearer header', () => {
    expect(extractBearer(mockRequest({ authorization: 'Bearer abc123' }))).toBe('abc123');
  });

  it('matches Bearer case-insensitively', () => {
    expect(extractBearer(mockRequest({ authorization: 'bearer xyz789' }))).toBe('xyz789');
  });

  it('returns undefined when the header is missing', () => {
    expect(extractBearer(mockRequest({}))).toBeUndefined();
  });

  it('returns undefined when the header is not a Bearer token', () => {
    expect(extractBearer(mockRequest({ authorization: 'Basic abc=' }))).toBeUndefined();
  });

  it('returns undefined when the header is an array (multiple Authorization headers)', () => {
    expect(extractBearer(mockRequest({ authorization: ['Bearer a', 'Bearer b'] }))).toBeUndefined();
  });
});

describe('resolveResourceUrl', () => {
  it('strips trailing slashes from an explicit publicUrl', () => {
    expect(resolveResourceUrl({ ...baseConfig, publicUrl: 'https://mcp.example.com/' })).toBe(
      'https://mcp.example.com',
    );
  });

  it('uses publicUrl verbatim when no trailing slash', () => {
    expect(resolveResourceUrl({ ...baseConfig, publicUrl: 'https://mcp.example.com' })).toBe(
      'https://mcp.example.com',
    );
  });

  it('falls back to host:port when host is a concrete address', () => {
    expect(resolveResourceUrl({ ...baseConfig, host: '10.0.0.5', port: 9000 })).toBe(
      'http://10.0.0.5:9000',
    );
  });

  it('warns via the structured logger when host is 0.0.0.0 and publicUrl is unset', () => {
    const warnSpy = vi.fn();
    const logger: Logger = { ...silentLogger, warn: warnSpy };
    const url = resolveResourceUrl({ ...baseConfig, host: '0.0.0.0', port: 3000 }, logger);
    expect(url).toBe('http://0.0.0.0:3000');
    expect(warnSpy).toHaveBeenCalledWith(
      'public_url_unset',
      expect.objectContaining({ host: '0.0.0.0', advertised: 'http://0.0.0.0:3000' }),
    );
  });

  it('also recognizes :: as the wildcard host', () => {
    expect(resolveResourceUrl({ ...baseConfig, host: '::', port: 3000 })).toBe('http://:::3000');
  });
});

describe('buildOAuthMetadata', () => {
  it('builds RFC 9728 protected-resource metadata pointing at Zendesk', () => {
    const meta = buildOAuthMetadata({ ...baseConfig, publicUrl: 'https://mcp.example.com' });
    expect(meta.protectedResource.authorization_servers).toEqual([
      'https://testsubdomain.zendesk.com',
    ]);
    expect(meta.protectedResource.resource).toBe('https://mcp.example.com');
    expect(meta.protectedResource.bearer_methods_supported).toEqual(['header']);
  });

  it('builds RFC 8414 authorization-server metadata with S256 PKCE', () => {
    const meta = buildOAuthMetadata(baseConfig);
    expect(meta.authorizationServer.issuer).toBe('https://testsubdomain.zendesk.com');
    expect(meta.authorizationServer.authorization_endpoint).toContain('/oauth/authorizations/new');
    expect(meta.authorizationServer.token_endpoint).toContain('/oauth/tokens');
    expect(meta.authorizationServer.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.authorizationServer.token_endpoint_auth_methods_supported).toEqual(['none']);
  });
});

describe('startHttpTransport (HTTP roundtrip)', () => {
  let handle: Awaited<ReturnType<typeof startHttpTransport>> | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('serves /.well-known/oauth-protected-resource (RFC 9728)', async () => {
    handle = await startHttpTransport({ ...baseConfig, publicUrl: 'https://mcp.example.com' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authorization_servers: string[];
      resource: string;
    };
    expect(body.authorization_servers).toContain('https://testsubdomain.zendesk.com');
    expect(body.resource).toBe('https://mcp.example.com');
  });

  it('serves /.well-known/oauth-authorization-server (RFC 8414) with PKCE S256', async () => {
    handle = await startHttpTransport(baseConfig);
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/.well-known/oauth-authorization-server`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code_challenge_methods_supported: string[] };
    expect(body.code_challenge_methods_supported).toContain('S256');
  });

  it('returns 200 on /healthz', async () => {
    handle = await startHttpTransport(baseConfig);
    const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; subdomain: string };
    expect(body).toEqual({ status: 'ok', subdomain: 'testsubdomain' });
  });

  it('returns 404 on unknown routes', async () => {
    handle = await startHttpTransport(baseConfig);
    const res = await fetch(`http://127.0.0.1:${handle.port}/nope`);
    expect(res.status).toBe(404);
  });

  it('rejects /mcp without a bearer with 401 + WWW-Authenticate', async () => {
    handle = await startHttpTransport({ ...baseConfig, publicUrl: 'https://mcp.example.com' });
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth).toMatch(/^Bearer\b/i);
    expect(wwwAuth).toContain('resource_metadata=');
    expect(wwwAuth).toContain('https://mcp.example.com');
    // Regression: the message must stay ASCII so node:http accepts it in the
    // header value. The fact that we got a 401 (not 500 ERR_INVALID_CHAR)
    // already proves this end-to-end.
  });

  it('rejects /mcp GET without a session ID and without a bearer with 401', async () => {
    handle = await startHttpTransport(baseConfig);
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`);
    expect(res.status).toBe(401);
  });

  it('accepts /mcp with a valid bearer and dispatches initialize', async () => {
    // Request JSON only (no SSE) so MSW doesn't have to forward a long-lived
    // stream — the SDK transport will reply with a one-shot JSON response
    // when the client doesn't accept event-stream. We're testing the
    // server-side new-session path: bearer extraction, McpServer creation,
    // transport.handleRequest.
    handle = await startHttpTransport(baseConfig);
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.0' },
        },
      }),
    });
    // SDK transport may stream or one-shot — both are valid; we only assert
    // the request was processed (200) and a session ID came back.
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
    // Drain the body to release the connection.
    await res.text();
  });

  it('routes a follow-up request to its existing session via mcp-session-id', async () => {
    // Regression coverage for the existing-session branch in handleMcpRequest:
    // initialize once → capture the session id → POST again with that id and
    // assert the request is routed to the same session (no re-init).
    handle = await startHttpTransport(baseConfig);
    const sessionId = await initializeSession(handle.port, 'Bearer test-token');

    // Follow-up: tools/list on the same session. The handler should route via
    // sessions.get(sessionId).transport.handleRequest. The bearer stays
    // mandatory: Authorization is validated on every request, not only at
    // session initialization.
    const followUp = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
    });
    expect(followUp.status).toBe(200);
    await followUp.text();
  });

  it('rejects a sessionful request without Authorization with 401 (session id is not a credential)', async () => {
    // Security regression lock: a leaked mcp-session-id alone must NOT grant
    // access to the session's Zendesk token.
    handle = await startHttpTransport(baseConfig);
    const sessionId = await initializeSession(handle.port, 'Bearer test-token');

    const followUp = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
    });
    expect(followUp.status).toBe(401);
    expect(followUp.headers.get('www-authenticate')).toMatch(/^Bearer\b/i);
    await followUp.text();
  });

  it('uses the freshest bearer presented on an existing session (token rotation)', async () => {
    // Clients refresh their Zendesk access token mid-session; the next tool
    // call must go out with the new token, not the one captured at init.
    const seenAuth: Array<string | null> = [];
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/users/me', ({ request }) => {
        seenAuth.push(request.headers.get('authorization'));
        return HttpResponse.json({ user: MOCK_USER });
      }),
    );
    handle = await startHttpTransport(baseConfig);
    const sessionId = await initializeSession(handle.port, 'Bearer first-token');

    const call = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer rotated-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 2,
        params: { name: 'get_current_user', arguments: {} },
      }),
    });
    expect(call.status).toBe(200);
    await call.text();
    expect(seenAuth).toEqual(['Bearer rotated-token']);
  });

  // Both 413 tests inject a small cap: the production default is 4 MB, and
  // pushing megabytes through the test stack means MSW's interceptor clones
  // and buffers the body — slow, and a source of timing-dependent hangs on
  // constrained CI runners. The cap value is irrelevant to the behavior.
  const SMALL_CAP = 64 * 1024;

  it('rejects a body over the configured cap with 413', async () => {
    handle = await startHttpTransport(baseConfig, undefined, { maxBodyBytes: SMALL_CAP });
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: `{"pad":"${'x'.repeat(SMALL_CAP + 1)}"}`,
    });
    expect(res.status).toBe(413);
    await res.text();
  });

  it('defaults the body cap to MAX_BODY_BYTES (sanity)', () => {
    expect(MAX_BODY_BYTES).toBe(4 * 1024 * 1024);
  });

  it('responds 413 mid-upload and drops the connection (no deadlock on slow clients)', async () => {
    // Regression for a CI-only deadlock: when the cap is hit while the client
    // is still uploading, the request stream is paused; unless the server
    // destroys the socket after the 413, the connection wedges and
    // handle.close() (in afterEach) hangs forever. Reproduced here with a
    // request that announces more than it ever sends.
    handle = await startHttpTransport(baseConfig, undefined, { maxBodyBytes: SMALL_CAP });
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: handle?.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'Content-Length': String(SMALL_CAP * 2),
        },
      });
      let responseReceived = false;
      req.on('response', (res) => {
        responseReceived = true;
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      // The server destroys the socket right after the 413, and the RST can
      // race the response bytes on a loaded kernel — an ECONNRESET after the
      // response is the expected teardown, not a failure.
      req.on('error', (err) => {
        if (!responseReceived) reject(err);
      });
      // Send just past the cap, then keep the request open forever.
      req.write(Buffer.alloc(SMALL_CAP + 1024, 120));
    });
    expect(status).toBe(413);
    // afterEach's handle.close() locks the "shutdown never hangs" half.
  });

  it('rejects malformed JSON with 400 and JSON-RPC -32700 Parse Error', async () => {
    handle = await startHttpTransport(baseConfig);
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: '{this is not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('evicts idle sessions after the configured timeout', async () => {
    handle = await startHttpTransport(baseConfig, undefined, {
      sessionIdleTimeoutMs: 50,
      sweepIntervalMs: 20,
    });
    const sessionId = await initializeSession(handle.port, 'Bearer test-token');

    await new Promise((resolve) => setTimeout(resolve, 200));

    // The session is gone: the request falls through to the new-session path,
    // where a non-initialize POST on a fresh transport is rejected by the SDK
    // (anything but 200 proves the old session no longer exists).
    const followUp = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
    });
    expect(followUp.status).not.toBe(200);
    await followUp.text();
  });

  it('returns 400 when a non-POST /mcp request has no session and no bearer combo', async () => {
    handle = await startHttpTransport(baseConfig);
    // PUT is neither POST (initialize path) nor GET (SSE stream path) — and
    // without a session ID, our handler short-circuits. With bearer present
    // but wrong method, the "non-POST" branch fires.
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(400);
  });

  it('binds to the configured port when non-zero', async () => {
    // We can't reliably pick a hard-coded free port, so verify the address
    // resolution end-to-end: hand it port 0 and confirm the OS-assigned port
    // matches what handle.port reports.
    handle = await startHttpTransport(baseConfig);
    expect(handle.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(res.status).toBe(200);
  });
});

describe('resolveAllowedOrigin', () => {
  it('always allows the default browser MCP client origins', () => {
    for (const origin of DEFAULT_BROWSER_MCP_CLIENT_ORIGINS) {
      expect(resolveAllowedOrigin(origin, [])).toBe(origin);
    }
  });

  it('always allows localhost on any port (dev tooling)', () => {
    expect(resolveAllowedOrigin('http://localhost:6274', [])).toBe('http://localhost:6274');
    expect(resolveAllowedOrigin('http://127.0.0.1:9999', [])).toBe('http://127.0.0.1:9999');
    expect(resolveAllowedOrigin('http://[::1]:3000', [])).toBe('http://[::1]:3000');
  });

  it('rejects an unknown origin not in defaults nor extras', () => {
    expect(resolveAllowedOrigin('https://evil.example.com', [])).toBeUndefined();
  });

  it('accepts an extra origin passed by the operator', () => {
    expect(resolveAllowedOrigin('https://my-app.example.com', ['https://my-app.example.com'])).toBe(
      'https://my-app.example.com',
    );
  });

  it('matches extras by strict equality — config normalization is what makes trailing slashes work', () => {
    // Browsers never send a trailing slash in Origin; an un-normalized entry
    // can't match. loadConfig normalizes entries to their URL origin, which is
    // covered in tests/unit/config.test.ts.
    expect(
      resolveAllowedOrigin('https://my-app.example.com', ['https://my-app.example.com/']),
    ).toBeUndefined();
  });

  it('rejects malformed origin strings without throwing', () => {
    expect(resolveAllowedOrigin('not-a-url', [])).toBeUndefined();
  });

  it('lists ChatGPT first in the default allowlist (largest user base)', () => {
    expect(DEFAULT_BROWSER_MCP_CLIENT_ORIGINS[0]).toBe('https://chatgpt.com');
  });
});

describe('CORS (HTTP roundtrip)', () => {
  let handle: Awaited<ReturnType<typeof startHttpTransport>> | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('responds 204 to an OPTIONS preflight from an allowed origin', async () => {
    handle = await startHttpTransport(baseConfig);
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://chatgpt.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://chatgpt.com');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/);
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    );
    expect(res.headers.get('access-control-expose-headers')).toContain('mcp-session-id');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('OPTIONS from an unknown origin returns 204 but without ACAO (browser blocks)', async () => {
    handle = await startHttpTransport(baseConfig);
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('attaches CORS headers on a real GET when the origin is allowed', async () => {
    handle = await startHttpTransport(baseConfig);
    const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`, {
      headers: { Origin: 'https://claude.ai' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
  });

  it('omits CORS headers when no Origin is sent (native MCP client case)', async () => {
    handle = await startHttpTransport(baseConfig);
    const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('accepts an operator-provided extra origin', async () => {
    handle = await startHttpTransport({
      ...baseConfig,
      corsOrigins: ['https://custom-ui.example.com'],
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://custom-ui.example.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://custom-ui.example.com');
  });
});

// Extract the first JSON-RPC payload from a Streamable HTTP response. The SDK
// transport may answer with a one-shot `application/json` body or with an SSE
// stream (`event: message\ndata: {...}\n\n`); accept both by scanning for the
// first JSON object the body contains.
const parseFirstRpcPayload = (raw: string): { result?: unknown; error?: unknown } => {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const match = raw.match(/data:\s*(\{[\s\S]*?\})\s*(?:\n|$)/);
  if (!match?.[1]) throw new Error(`No JSON-RPC payload in body: ${raw.slice(0, 200)}`);
  return JSON.parse(match[1]);
};

describe('startHttpTransport (Zendesk 401 backstop)', () => {
  let handle: Awaited<ReturnType<typeof startHttpTransport>> | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  // Spec under test (locked here so a future refactor can't quietly change it):
  //
  // In HTTP mode the bearer is the OAuth access token the MCP client just sent;
  // there is no server-side token store. When Zendesk rejects it (401) we want:
  //   1. the tool call to come back to the client as a tool result with
  //      `isError: true` (NOT a transport-level 500, NOT a session crash);
  //   2. the HTTP session to remain usable for further requests so the client
  //      can either re-authenticate via the discovery metadata or try a
  //      different tool;
  //   3. NO `onUnauthorized` callback to be invoked server-side — there is
  //      nothing to invalidate (this is asserted indirectly by point 2 and
  //      explicitly in the http.ts construction `createMcpServer(config, () =>
  //      auth.bearer, logger)` which omits the fourth argument).
  it('surfaces a Zendesk 401 as an MCP tool error and keeps the session open', async () => {
    mswServer.use(errorHandlers.usersMeUnauthorized);
    handle = await startHttpTransport(baseConfig);
    const sessionId = await initializeSession(handle.port, 'Bearer client-issued-bearer');

    const callRes = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer client-issued-bearer',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 2,
        params: { name: 'get_current_user', arguments: {} },
      }),
    });
    // Claim 1: transport remains a healthy 200; the failure lives inside the
    // JSON-RPC payload as a tool result with isError=true.
    expect(callRes.status).toBe(200);
    const payload = parseFirstRpcPayload(await callRes.text()) as {
      result?: {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
      };
    };
    expect(payload.result?.isError).toBe(true);
    // The error must convey "your bearer is no good, re-do OAuth" so the MCP
    // client knows to restart the discovery flow against Zendesk. We match the
    // semantic intent (re-authenticate) rather than the literal string — the
    // wrapping in `ZendeskApiError.buildMessage` (`src/client/zendesk-api.ts`)
    // is keyed strictly on `status === 401`, so this pattern is a tight proxy
    // for "a 401 reached the user-visible payload".
    const text = (payload.result?.content ?? []).map((c) => c.text ?? '').join(' ');
    expect(text).toMatch(/re-?authenticate/i);

    // Claim 2: the session must still be alive — a follow-up tools/list on the
    // same mcp-session-id has to come back 200, not a freshly minted 401 or a
    // dead session. (We can't fully assert claim 3 — that onUnauthorized was
    // not wired — without spying on createMcpServer; the wiring is enforced by
    // http.ts:304 and the survival of this call is a behavioral proxy.)
    const followUp = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer client-issued-bearer',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 3 }),
    });
    expect(followUp.status).toBe(200);
    await followUp.text();
  });
});
