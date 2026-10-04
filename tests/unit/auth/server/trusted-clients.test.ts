import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '../../../../src/auth/server/file-store';
import { deriveKeyRing } from '../../../../src/auth/server/keys';
import { createSealedCollection, type SealedCollection } from '../../../../src/auth/server/store';
import {
  CIMD_FETCH_HINT,
  type CimdLastGood,
  canSkipConsent,
  createCimdFetch,
  DEFAULT_TRUSTED_CLIENTS,
  inferNativeApplication,
  isLoopbackHost,
  isSkipEligibleRedirect,
  LAST_GOOD_TTL_S,
  trustedClientSet,
} from '../../../../src/auth/server/trusted-clients';
import type { Logger } from '../../../../src/utils/logger';

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

describe('createCimdFetch: the last good copy', () => {
  const URL_ = 'https://claude.ai/oauth/claude-code-client-metadata';
  const DOC = {
    client_id: URL_,
    client_name: 'Claude Code',
    redirect_uris: ['http://localhost/cb'],
  };
  const NOW = Date.UTC(2026, 9, 4, 12);

  const memoryLastGood = () => {
    const records = new Map<string, { value: CimdLastGood; ttl: number | undefined }>();
    const lastGood: SealedCollection<CimdLastGood> = {
      get: async (id) => records.get(id)?.value,
      set: async (id, value, ttl) => {
        records.set(id, { value, ttl });
      },
      delete: async (id) => {
        records.delete(id);
      },
    };
    return { lastGood, records };
  };

  const recordingLogger = () => {
    const events: [string, string, unknown][] = [];
    const record =
      (level: string) =>
      (event: string, fields?: unknown): void => {
        events.push([level, event, fields]);
      };
    const logger: Logger = {
      debug: () => undefined,
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      attachServer: vi.fn(),
    };
    return { logger, events };
  };

  // A fetch answering the document first, then whatever `next` says.
  const sequence = (...steps: (() => Response)[]) => {
    let index = 0;
    return vi.fn(async () => {
      const step = steps[Math.min(index++, steps.length - 1)] as () => Response;
      return step();
    });
  };
  const ok = () => Response.json(DOC, { headers: { 'cache-control': 'max-age=300' } });
  const status = (code: number) => () => new Response('blocked', { status: code });
  const networkError = () => {
    throw new TypeError('fetch failed');
  };

  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('keeps a client document served at its own client_id, raw, for seven days', async () => {
    const { lastGood, records } = memoryLastGood();
    const res = await createCimdFetch(sequence(ok), { lastGood })(URL_, {});
    expect(await res.json()).toEqual({ ...DOC, application_type: 'native' });
    expect(records.get(URL_)).toEqual({ value: { document: DOC, fetchedAt: NOW }, ttl: 604800 });
    expect(LAST_GOOD_TTL_S).toBe(7 * 24 * 3600);
  });

  it('keeps nothing that is not a client document of that very URL', async () => {
    const { lastGood, records } = memoryLastGood();
    const cimd = createCimdFetch(
      sequence(
        () => Response.json({ ...DOC, client_id: 'https://evil.example/doc' }),
        () => Response.json({ keys: [] }),
        () => new Response('not json'),
        () => Response.json({ ...DOC, pad: 'x'.repeat(17 * 1024) }),
      ),
      { lastGood },
    );
    for (let i = 0; i < 4; i++) await cimd(URL_, {});
    expect(records.size).toBe(0);
  });

  it.each([403, 408, 429, 500, 502, 503])(
    'serves the last good copy on a %i, and says so',
    async (code) => {
      const { lastGood } = memoryLastGood();
      const { logger, events } = recordingLogger();
      const cimd = createCimdFetch(sequence(ok, status(code)), { lastGood, logger });
      await cimd(URL_, {});
      vi.advanceTimersByTime(3600 * 1000);
      const res = await cimd(URL_, {});
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('cache-control')).toBe('max-age=60');
      expect(await res.json()).toEqual({ ...DOC, application_type: 'native' });
      expect(events).toEqual([
        [
          'warn',
          'oauth_client_fetch_failed',
          { url: URL_, status: code, fallback: 'last_good', ageS: 3600, hint: CIMD_FETCH_HINT },
        ],
      ]);
    },
  );

  it('serves the last good copy on a network error', async () => {
    const { lastGood } = memoryLastGood();
    const { logger, events } = recordingLogger();
    const cimd = createCimdFetch(sequence(ok, networkError), { lastGood, logger });
    await cimd(URL_, {});
    const res = await cimd(URL_, {});
    expect(await res.json()).toEqual({ ...DOC, application_type: 'native' });
    expect(events).toEqual([
      [
        'warn',
        'oauth_client_fetch_failed',
        { url: URL_, error: 'fetch failed', fallback: 'last_good', ageS: 0, hint: CIMD_FETCH_HINT },
      ],
    ]);
  });

  it.each([404, 410, 401, 400, 302])(
    'never falls back on a %i: the document is gone or the request is wrong',
    async (code) => {
      const { lastGood } = memoryLastGood();
      const { logger, events } = recordingLogger();
      const failure = new Response('gone', { status: code });
      const cimd = createCimdFetch(
        sequence(ok, () => failure),
        { lastGood, logger },
      );
      await cimd(URL_, {});
      expect(await cimd(URL_, {})).toBe(failure);
      expect(events).toEqual([
        [
          'warn',
          'oauth_client_fetch_failed',
          { url: URL_, status: code, fallback: 'none', hint: CIMD_FETCH_HINT },
        ],
      ]);
    },
  );

  it('hands the failure on when no copy was ever kept', async () => {
    const { lastGood } = memoryLastGood();
    const { logger, events } = recordingLogger();
    const failure = new Response('blocked', { status: 403 });
    expect(await createCimdFetch(async () => failure, { lastGood, logger })(URL_, {})).toBe(
      failure,
    );
    await expect(createCimdFetch(networkError, { lastGood, logger })(URL_, {})).rejects.toThrow(
      'fetch failed',
    );
    expect(events).toEqual([
      [
        'warn',
        'oauth_client_fetch_failed',
        { url: URL_, status: 403, fallback: 'none', hint: CIMD_FETCH_HINT },
      ],
      [
        'warn',
        'oauth_client_fetch_failed',
        { url: URL_, error: 'fetch failed', fallback: 'none', hint: CIMD_FETCH_HINT },
      ],
    ]);
  });

  it('logs a failure without a store, and keeps nothing', async () => {
    const { logger, events } = recordingLogger();
    const failure = new Response('blocked', { status: 503 });
    expect(await createCimdFetch(async () => failure, { logger })(URL_, {})).toBe(failure);
    expect(await (await createCimdFetch(sequence(ok), { logger })(URL_, {})).json()).toEqual({
      ...DOC,
      application_type: 'native',
    });
    expect(events).toEqual([
      [
        'warn',
        'oauth_client_fetch_failed',
        { url: URL_, status: 503, fallback: 'none', hint: CIMD_FETCH_HINT },
      ],
    ]);
  });

  it('forgets the copy seven days after the last successful fetch', async () => {
    const lastGood = createSealedCollection<CimdLastGood>(
      createMemoryStore(),
      'CimdDocument',
      deriveKeyRing(Buffer.alloc(32, 3).toString('base64')),
    );
    const cimd = createCimdFetch(sequence(ok, status(403)), { lastGood });
    await cimd(URL_, {});
    vi.advanceTimersByTime(LAST_GOOD_TTL_S * 1000 - 1);
    expect((await cimd(URL_, {})).status).toBe(200);
    vi.advanceTimersByTime(1);
    expect((await cimd(URL_, {})).status).toBe(403);
  });

  it('names the cause of a network error', async () => {
    const { logger, events } = recordingLogger();
    const refused = () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND claude.ai') });
    };
    await expect(createCimdFetch(refused, { logger })(URL_, {})).rejects.toThrow('fetch failed');
    await expect(createCimdFetch(() => Promise.reject('odd'), { logger })(URL_, {})).rejects.toBe(
      'odd',
    );
    expect(events.map(([, , fields]) => (fields as { error: string }).error)).toEqual([
      'fetch failed: getaddrinfo ENOTFOUND claude.ai',
      'odd',
    ]);
  });

  it('hands the failure on when reading the kept copy fails too', async () => {
    const { logger, events } = recordingLogger();
    const lastGood: SealedCollection<CimdLastGood> = {
      get: async () => {
        throw new Error('EIO');
      },
      set: async () => undefined,
      delete: async () => undefined,
    };
    const failure = new Response('blocked', { status: 403 });
    expect(await createCimdFetch(async () => failure, { lastGood, logger })(URL_, {})).toBe(
      failure,
    );
    expect(events).toEqual([
      ['warn', 'oauth_cimd_last_good_read_failed', { url: URL_, error: 'EIO' }],
      [
        'warn',
        'oauth_client_fetch_failed',
        { url: URL_, status: 403, fallback: 'none', hint: CIMD_FETCH_HINT },
      ],
    ]);
  });

  it('serves the live document when keeping its copy fails', async () => {
    const { logger, events } = recordingLogger();
    const lastGood: SealedCollection<CimdLastGood> = {
      get: async () => undefined,
      set: async () => {
        throw new Error('ENOSPC');
      },
      delete: async () => undefined,
    };
    const res = await createCimdFetch(sequence(ok), { lastGood, logger })(URL_, {});
    expect((await res.json()).client_id).toBe(URL_);
    expect(events).toEqual([
      ['warn', 'oauth_cimd_last_good_store_failed', { url: URL_, error: 'ENOSPC' }],
    ]);
  });

  it('keeps going without a logger when keeping or reading the copy fails', async () => {
    const lastGood: SealedCollection<CimdLastGood> = {
      get: async () => {
        throw new Error('EIO');
      },
      set: async () => {
        throw new Error('ENOSPC');
      },
      delete: async () => undefined,
    };
    const cimd = createCimdFetch(sequence(ok, status(403)), { lastGood });
    expect((await cimd(URL_, {})).status).toBe(200);
    expect((await cimd(URL_, {})).status).toBe(403);
  });

  it('says what failed and where to read on', () => {
    expect(CIMD_FETCH_HINT).toMatchInlineSnapshot(
      `"A client document could not be fetched: its client cannot sign in or refresh unless a last good copy is served. See https://github.com/fruggr/zendesk-mcp-server/blob/main/docs/troubleshooting.md#http-the-log-shows-oauth_client_fetch_failed"`,
    );
  });

  it('points the hint at a troubleshooting section that exists on main', () => {
    const [, link = ''] = CIMD_FETCH_HINT.match(/(https:\/\/\S+)/) ?? [];
    const { pathname, hash } = new URL(link);
    expect(pathname).toBe('/fruggr/zendesk-mcp-server/blob/main/docs/troubleshooting.md');
    const anchors = [
      ...readFileSync('docs/troubleshooting.md', 'utf8').matchAll(/^#{1,6} (.+)$/gm),
    ].map(([, title = '']) =>
      title
        .toLowerCase()
        .replace(/[^\w\- ]/g, '')
        .replaceAll(' ', '-'),
    );
    expect(anchors).toContain(hash.slice(1));
    expect(CIMD_FETCH_HINT).toMatch(/^[\x20-\x7e]+$/);
  });
});
