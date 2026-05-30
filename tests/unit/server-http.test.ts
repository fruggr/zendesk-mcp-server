import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { getSessionToken } from '../../src/auth/session-token';
import type { Config } from '../../src/config';
import { filterTools } from '../../src/routing/registry';
import {
  buildProxyDispatch,
  createMcpServer,
  extractBearer,
  resolveResourceUrl,
  wrapLeafExecute,
  wrapProxyExecute,
} from '../../src/server';
import { createAllTools } from '../../src/tools/index';

const baseConfig: Config = {
  subdomain: 'testsubdomain',
  oauthClientId: 'test_zendesk',
  logLevel: 'info',
  mode: 'all',
  readOnly: false,
  transport: 'http',
  host: '127.0.0.1',
  port: 3000,
};

const mockRequest = (headers: Record<string, string | string[]>): IncomingMessage =>
  ({ headers }) as unknown as IncomingMessage;

describe('extractBearer', () => {
  it('returns the token from a well-formed Bearer header', () => {
    expect(extractBearer(mockRequest({ authorization: 'Bearer abc123' }))).toBe('abc123');
  });

  it('matches Bearer case-insensitively', () => {
    expect(extractBearer(mockRequest({ authorization: 'bearer xyz789' }))).toBe('xyz789');
  });

  it('throws when the header is missing', () => {
    expect(() => extractBearer(mockRequest({}))).toThrow(/Missing Authorization/);
  });

  it('throws when the header is not a Bearer token', () => {
    expect(() => extractBearer(mockRequest({ authorization: 'Basic abc=' }))).toThrow();
  });

  it('throws when the header is an array (multiple Authorization headers)', () => {
    expect(() => extractBearer(mockRequest({ authorization: ['Bearer a', 'Bearer b'] }))).toThrow();
  });

  it('error message is ASCII-only (mcp-proxy embeds it in WWW-Authenticate)', () => {
    try {
      extractBearer(mockRequest({}));
      throw new Error('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      // node:http rejects non-ASCII bytes in header values with ERR_INVALID_CHAR.
      for (let i = 0; i < msg.length; i++) {
        expect(msg.charCodeAt(i)).toBeLessThanOrEqual(127);
      }
    }
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
    const calls: string[] = [];
    const original = console.error;
    console.error = (msg: unknown) => {
      calls.push(String(msg));
    };
    try {
      const url = resolveResourceUrl({ ...baseConfig, host: '0.0.0.0', port: 3000 });
      expect(url).toBe('http://0.0.0.0:3000');
      expect(calls.some((c) => c.includes('WARNING') && c.includes('PUBLIC_URL'))).toBe(true);
    } finally {
      console.error = original;
    }
  });

  it('also recognizes :: as the wildcard host', () => {
    const original = console.error;
    console.error = () => {};
    try {
      expect(resolveResourceUrl({ ...baseConfig, host: '::', port: 3000 })).toBe('http://:::3000');
    } finally {
      console.error = original;
    }
  });
});

describe('wrapLeafExecute', () => {
  const sampleHandler = async (params: Record<string, unknown>) =>
    ({ content: [{ type: 'text' as const, text: `args:${JSON.stringify(params)}` }] }) as const;

  it('stdio mode calls the handler directly without touching session', async () => {
    const wrapped = wrapLeafExecute({ ...baseConfig, transport: 'stdio' }, sampleHandler);
    const out = await wrapped({ x: 1 }, {});
    expect(out.content[0]).toMatchObject({ type: 'text', text: 'args:{"x":1}' });
  });

  it('http mode reads the bearer from ctx.session and exposes it via getSessionToken', async () => {
    const captured: string[] = [];
    const tokenObserver = async () => {
      captured.push(getSessionToken());
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    };
    const wrapped = wrapLeafExecute({ ...baseConfig, transport: 'http' }, tokenObserver);
    await wrapped({}, { session: { accessToken: 'tok-leaf-A' } });
    expect(captured).toEqual(['tok-leaf-A']);
  });

  it('http mode throws when ctx.session is missing', async () => {
    const wrapped = wrapLeafExecute({ ...baseConfig, transport: 'http' }, sampleHandler);
    await expect(wrapped({}, {})).rejects.toThrow(/Session is missing accessToken/);
  });
});

describe('wrapProxyExecute', () => {
  const body = async (args: Record<string, unknown>) =>
    ({ content: [{ type: 'text' as const, text: `body:${args['op']}` }] }) as const;

  it('stdio mode calls the body without touching session', async () => {
    const wrapped = wrapProxyExecute({ ...baseConfig, transport: 'stdio' }, body);
    const out = await wrapped({ op: 'x' }, {});
    expect(out.content[0]).toMatchObject({ type: 'text', text: 'body:x' });
  });

  it('http mode reads the bearer from ctx.session', async () => {
    const captured: string[] = [];
    const observer = async () => {
      captured.push(getSessionToken());
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    };
    const wrapped = wrapProxyExecute({ ...baseConfig, transport: 'http' }, observer);
    await wrapped({}, { session: { accessToken: 'tok-proxy-B' } });
    expect(captured).toEqual(['tok-proxy-B']);
  });

  it('http mode throws when ctx.session is missing', async () => {
    const wrapped = wrapProxyExecute({ ...baseConfig, transport: 'http' }, body);
    await expect(wrapped({}, {})).rejects.toThrow(/Session is missing accessToken/);
  });
});

describe('buildProxyDispatch', () => {
  const allTools = createAllTools({ subdomain: 'testsubdomain', getToken: () => 'test-token' });
  const ticketsOnly = filterTools(allTools, { readOnly: false, namespaces: ['tickets'] });

  it('dispatches a valid operation through the original handler', async () => {
    const dispatch = buildProxyDispatch(ticketsOnly);
    // search_tickets is in the tickets namespace and hits MSW's /search handler.
    const out = await dispatch({ operation: 'search_tickets', params: { query: 'status:open' } });
    expect(out.content[0]?.type).toBe('text');
  });
});

describe('createMcpServer (http)', () => {
  it('exposes an authenticate callback that extracts the bearer', async () => {
    const { server } = createMcpServer(
      { ...baseConfig, publicUrl: 'https://mcp.example.com' },
      getSessionToken,
    );
    const { authenticate } = server.options;
    expect(authenticate).toBeTypeOf('function');
    const auth = await authenticate?.(mockRequest({ authorization: 'Bearer test-tok' }));
    expect(auth).toMatchObject({ accessToken: 'test-tok' });
  });

  it('authenticate rejects malformed headers', async () => {
    const { server } = createMcpServer(
      { ...baseConfig, publicUrl: 'https://mcp.example.com' },
      getSessionToken,
    );
    await expect(server.options.authenticate?.(mockRequest({}))).rejects.toThrow(
      /Missing Authorization/,
    );
  });

  it('does not configure authenticate or oauth in stdio mode', () => {
    const { server } = createMcpServer({ ...baseConfig, transport: 'stdio' }, () => 'tok');
    expect(server.options.authenticate).toBeUndefined();
    expect(server.options.oauth).toBeUndefined();
  });
});
