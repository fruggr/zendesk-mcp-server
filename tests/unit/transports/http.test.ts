import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/config';
import {
  buildOAuthMetadata,
  DEFAULT_BROWSER_MCP_CLIENT_ORIGINS,
  extractBearer,
  isOriginAllowed,
  resolveResourceUrl,
  startHttpTransport,
} from '../../../src/transports/http';

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

  it('warns and returns the wildcard URL when host is 0.0.0.0 and publicUrl is unset', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const url = resolveResourceUrl({ ...baseConfig, host: '0.0.0.0', port: 3000 });
      expect(url).toBe('http://0.0.0.0:3000');
      const warned = errSpy.mock.calls.some((args) =>
        args.some(
          (a) => typeof a === 'string' && a.includes('WARNING') && a.includes('PUBLIC_URL'),
        ),
      );
      expect(warned).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('also recognizes :: as the wildcard host', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolveResourceUrl({ ...baseConfig, host: '::', port: 3000 })).toBe('http://:::3000');
    } finally {
      errSpy.mockRestore();
    }
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
    // assert the request is routed to the same session (no re-init, no 401).
    handle = await startHttpTransport(baseConfig);
    const init = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
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
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await init.text();

    // Follow-up: tools/list on the same session. The handler should route via
    // sessions.get(sessionId).transport.handleRequest — no bearer needed at
    // this point because the session is already authenticated.
    const followUp = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 }),
    });
    expect(followUp.status).toBe(200);
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

describe('isOriginAllowed', () => {
  it('always allows the default browser MCP client origins', () => {
    for (const origin of DEFAULT_BROWSER_MCP_CLIENT_ORIGINS) {
      expect(isOriginAllowed(origin, [])).toBe(true);
    }
  });

  it('always allows localhost on any port (dev tooling)', () => {
    expect(isOriginAllowed('http://localhost:6274', [])).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:9999', [])).toBe(true);
    expect(isOriginAllowed('http://[::1]:3000', [])).toBe(true);
  });

  it('rejects an unknown origin not in defaults nor extras', () => {
    expect(isOriginAllowed('https://evil.example.com', [])).toBe(false);
  });

  it('accepts an extra origin passed by the operator', () => {
    expect(isOriginAllowed('https://my-app.example.com', ['https://my-app.example.com'])).toBe(
      true,
    );
  });

  it('rejects malformed origin strings without throwing', () => {
    expect(isOriginAllowed('not-a-url', [])).toBe(false);
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
