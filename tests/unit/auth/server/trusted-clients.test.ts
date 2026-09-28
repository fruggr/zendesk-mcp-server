import { describe, expect, it, vi } from 'vitest';
import {
  canSkipConsent,
  createCimdFetch,
  DEFAULT_TRUSTED_CLIENTS,
  inferNativeApplication,
  isLoopbackHost,
  isSkipEligibleRedirect,
  trustedClientSet,
} from '../../../../src/auth/server/trusted-clients';

const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const trusted = trustedClientSet([], true);

describe('trustedClientSet', () => {
  it('seeds claude.ai and ChatGPT only', () => {
    expect(DEFAULT_TRUSTED_CLIENTS).toEqual([CLAUDE, 'https://chatgpt.com/oauth/client.json']);
  });

  it('adds extra entries and can drop the seed', () => {
    expect([...trustedClientSet(['https://x.example/c.json'], true)]).toEqual([
      ...DEFAULT_TRUSTED_CLIENTS,
      'https://x.example/c.json',
    ]);
    expect([...trustedClientSet(['https://x.example/c.json'], false)]).toEqual([
      'https://x.example/c.json',
    ]);
  });
});

describe('isLoopbackHost', () => {
  it.each(['localhost', '127.0.0.1', '127.10.20.30', '[::1]'])('%s is loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });
  it.each([
    'claude.ai',
    '128.0.0.1',
    '127.0.0.1.example.com',
    'x127.0.0.1',
    'localhost.example.com',
    '10.0.0.1',
  ])('%s is not loopback', (host) => expect(isLoopbackHost(host)).toBe(false));
});

describe('isSkipEligibleRedirect', () => {
  it.each([
    [CLAUDE_CALLBACK, true],
    ['https://chatgpt.com/connector_platform_oauth_redirect', true],
    ['http://claude.ai/api/mcp/auth_callback', false],
    ['https://localhost/callback', false],
    ['https://127.0.0.1:8443/cb', false],
    ['https://[::1]/cb', false],
    ['cursor://anysphere.cursor-retrieval/oauth/callback', false],
    ['not a url', false],
  ])('%s → %s', (uri, expected) => expect(isSkipEligibleRedirect(uri)).toBe(expected));
});

describe('canSkipConsent', () => {
  const base = {
    clientId: CLAUDE,
    redirectUri: CLAUDE_CALLBACK,
    registeredRedirectUris: [CLAUDE_CALLBACK],
  };

  it('skips for a trusted client using a listed HTTPS redirect', () => {
    expect(canSkipConsent(base, trusted)).toBe(true);
  });

  it('never matches on the domain: Claude Code on claude.ai still sees the screen', () => {
    expect(
      canSkipConsent(
        {
          clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
          redirectUri: 'http://localhost/callback',
          registeredRedirectUris: ['http://localhost/callback'],
        },
        trusted,
      ),
    ).toBe(false);
  });

  it('requires the redirect to be listed in the fetched document', () => {
    expect(
      canSkipConsent({ ...base, registeredRedirectUris: ['https://claude.ai/other'] }, trusted),
    ).toBe(false);
  });

  it('requires an HTTPS, non-loopback redirect even when listed', () => {
    const loopback = 'http://127.0.0.1/callback';
    expect(
      canSkipConsent(
        { ...base, redirectUri: loopback, registeredRedirectUris: [loopback] },
        trusted,
      ),
    ).toBe(false);
  });

  it('shows the screen to an untrusted client', () => {
    expect(canSkipConsent(base, trustedClientSet([], false))).toBe(false);
  });
});

describe('inferNativeApplication', () => {
  it('marks an all-loopback document as native', () => {
    expect(
      inferNativeApplication({
        client_id: 'x',
        redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
      }),
    ).toEqual({
      client_id: 'x',
      redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
      application_type: 'native',
    });
  });

  it('leaves mixed, HTTPS, empty and explicit documents alone', () => {
    const mixed = { redirect_uris: ['http://127.0.0.1:33418/', 'https://vscode.dev/redirect'] };
    const https = { redirect_uris: ['https://localhost/cb'] };
    const empty = { redirect_uris: [] };
    const explicit = { application_type: 'web', redirect_uris: ['http://localhost/cb'] };
    const notArray = { redirect_uris: 'http://localhost/cb' };
    for (const doc of [mixed, https, empty, explicit, notArray])
      expect(inferNativeApplication(doc)).toBe(doc);
    for (const value of [null, 'x', [1]]) expect(inferNativeApplication(value)).toBe(value);
  });

  it('leaves a document alone when a redirect URI is not a parseable string', () => {
    const unparseable = { redirect_uris: ['not a url'] };
    const notString = { redirect_uris: [new URL('http://localhost/cb')] };
    for (const doc of [unparseable, notString]) expect(inferNativeApplication(doc)).toBe(doc);
  });

  it('leaves a non-object alone even when it carries loopback redirect URIs', () => {
    const fn = Object.assign(() => undefined, { redirect_uris: ['http://localhost/cb'] });
    expect(inferNativeApplication(fn)).toBe(fn);
  });
});

describe('createCimdFetch', () => {
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
      ...init,
    });

  it('passes the request options through untouched (they carry the SSRF guard)', async () => {
    const base = vi.fn(async () => json({ keys: [] }));
    const options = { redirect: 'manual', signal: AbortSignal.timeout(1000) } as RequestInit;
    await createCimdFetch(base)('https://x.example/doc', options);
    expect(base).toHaveBeenCalledWith('https://x.example/doc', options);
  });

  it('rewrites an all-loopback client document to native', async () => {
    const doc = {
      client_id: 'https://zed.dev/oauth/client-metadata.json',
      redirect_uris: ['http://127.0.0.1/callback'],
    };
    const res = await createCimdFetch(async () =>
      json(doc, { headers: { 'cache-control': 'max-age=60' } }),
    )('https://zed.dev/oauth/client-metadata.json', {});
    expect(await res.json()).toEqual({ ...doc, application_type: 'native' });
    expect(res.headers.get('cache-control')).toBe('max-age=60');
  });

  it('returns other JSON, non-JSON and error responses as they came', async () => {
    const jwks = await createCimdFetch(async () => json({ keys: [{ kty: 'RSA' }] }))(
      'https://x/jwks',
      {},
    );
    expect(await jwks.json()).toEqual({ keys: [{ kty: 'RSA' }] });
    const text = await createCimdFetch(async () => new Response('not json'))('https://x/doc', {});
    expect(await text.text()).toBe('not json');
    const upstreamFailure = new Response('nope', { status: 403 });
    const failed = await createCimdFetch(async () => upstreamFailure)('https://x/doc', {});
    expect(failed).toBe(upstreamFailure);
    expect(failed.status).toBe(403);
    expect(await failed.text()).toBe('nope');
  });

  it('hands on a non-document byte for byte, with its status and headers', async () => {
    const raw = '{ "keys": [ { "kty": "RSA" } ] }';
    const res = await createCimdFetch(
      async () =>
        new Response(raw, { status: 203, headers: { 'content-type': 'application/jwk-set+json' } }),
    )('https://x/jwks', {});
    expect(res.status).toBe(203);
    expect(res.headers.get('content-type')).toBe('application/jwk-set+json');
    expect(await res.text()).toBe(raw);
    const nullBody = await createCimdFetch(async () => new Response('null'))('https://x/doc', {});
    expect(await nullBody.text()).toBe('null');
  });

  it('hands an oversized body on without parsing it, for the library to reject', async () => {
    const big = 'x'.repeat(64 * 1024);
    const res = await createCimdFetch(async () => new Response(big))('https://x/doc', {});
    const body = await res.text();
    expect(body.length).toBeGreaterThan(16 * 1024);
    expect(body.startsWith('xxx')).toBe(true);
  });

  // The cap is 16 KiB: a body is read up to the first chunk that crosses it.
  const chunked = (chunks: Uint8Array[]) => {
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[index++];
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    return new Response(stream);
  };

  it('stops reading at the first chunk past the cap', async () => {
    const source = chunked(Array.from({ length: 64 }, () => new Uint8Array(1024).fill(120)));
    const res = await createCimdFetch(async () => source)('https://x/doc', {});
    expect((await res.text()).length).toBe(17 * 1024);
  });

  it('reads on past a body that exactly fills the cap', async () => {
    const source = chunked([new Uint8Array(16 * 1024).fill(120), new Uint8Array(1).fill(120)]);
    const res = await createCimdFetch(async () => source)('https://x/doc', {});
    expect((await res.text()).length).toBe(16 * 1024 + 1);
  });

  const paddedDocument = (size: number) => {
    const doc = { client_id: 'https://x/doc', redirect_uris: ['http://localhost/cb'], pad: '' };
    const pad = size - JSON.stringify(doc).length;
    return JSON.stringify({ ...doc, pad: 'x'.repeat(pad) });
  };

  it('still rewrites a client document of exactly the cap', async () => {
    const raw = paddedDocument(16 * 1024);
    expect(raw.length).toBe(16 * 1024);
    const res = await createCimdFetch(async () => new Response(raw))('https://x/doc', {});
    expect((await res.json()).application_type).toBe('native');
  });

  it('never rewrites a client document past the cap, even one that parses', async () => {
    const raw = paddedDocument(16 * 1024 + 1);
    const res = await createCimdFetch(async () => new Response(raw))('https://x/doc', {});
    expect(await res.text()).toBe(raw);
  });

  it('copes with an empty body', async () => {
    const res = await createCimdFetch(async () => new Response(null))('https://x/doc', {});
    expect(await res.text()).toBe('');
  });
});
