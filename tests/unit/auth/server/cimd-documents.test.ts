import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CIMD_FETCH_HINT,
  type CimdLastGood,
  createCimdDocuments,
  LAST_GOOD_TTL_S,
} from '../../../../src/auth/server/cimd-documents';
import { createMemoryStore } from '../../../../src/auth/server/file-store';
import { deriveKeyRing } from '../../../../src/auth/server/keys';
import { createSealedCollection, type SealedCollection } from '../../../../src/auth/server/store';
import type { Fetch } from '../../../../src/auth/server/trusted-clients';
import type { Logger } from '../../../../src/utils/logger';

const URL_ = 'https://claude.ai/oauth/claude-code-client-metadata';
const DOC = { client_id: URL_, client_name: 'Claude Code', redirect_uris: ['http://localhost/cb'] };
const NATIVE = { ...DOC, application_type: 'native' };
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
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    attachServer: vi.fn(),
  };
  return { logger, events };
};

// A fetch answering each step in turn, then the last one forever.
const sequence = (...steps: (() => Response)[]): Fetch => {
  let index = 0;
  return async () => (steps[Math.min(index++, steps.length - 1)] as () => Response)();
};
const ok = () => Response.json(DOC, { headers: { 'cache-control': 'max-age=300' } });
const status = (code: number) => () => new Response('blocked', { status: code });
const networkError = () => {
  throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND claude.ai') });
};

const setUp = (base: Fetch, lastGood = memoryLastGood().lastGood) => {
  const { logger, events } = recordingLogger();
  return { cimd: createCimdDocuments(base, { lastGood, logger }), events };
};

// What oidc-provider does on a sign-in: fetch, accept the client, issue a token.
const signIn = async (cimd: ReturnType<typeof createCimdDocuments>) => {
  const res = await cimd.fetch(URL_, {});
  cimd.accepted(URL_);
  await cimd.granted(URL_);
  return res;
};

const failed = (fields: Record<string, unknown>) => [
  'warn',
  'oauth_client_fetch_failed',
  { url: URL_, ...fields, hint: CIMD_FETCH_HINT },
];

beforeEach(() => vi.useFakeTimers({ now: NOW }));
afterEach(() => vi.useRealTimers());

describe('createCimdDocuments: keeping a copy', () => {
  it('keeps a document once it was accepted and a token issued, for seven days', async () => {
    const { lastGood, records } = memoryLastGood();
    const { cimd } = setUp(sequence(ok), lastGood);
    const res = await signIn(cimd);
    expect(await res.json()).toEqual(NATIVE);
    expect(res.headers.get('cache-control')).toBe('max-age=300');
    expect(records.get(URL_)).toEqual({ value: { document: NATIVE, fetchedAt: NOW }, ttl: 604800 });
    expect(LAST_GOOD_TTL_S).toBe(7 * 24 * 3600);
  });

  it('keeps nothing for a client that was fetched but never got a token', async () => {
    const { lastGood, records } = memoryLastGood();
    const { cimd } = setUp(sequence(ok), lastGood);
    await cimd.fetch(URL_, {});
    cimd.accepted(URL_);
    await cimd.granted('https://other.example/doc');
    expect(records.size).toBe(0);
  });

  it('keeps nothing oidc-provider did not accept', async () => {
    const { lastGood, records } = memoryLastGood();
    const { cimd } = setUp(sequence(ok), lastGood);
    await cimd.fetch(URL_, {});
    await cimd.granted(URL_);
    expect(records.size).toBe(0);
  });

  it('keeps a copy once per fetch, not on every token', async () => {
    const { lastGood, records } = memoryLastGood();
    const { cimd } = setUp(sequence(ok), lastGood);
    await signIn(cimd);
    records.clear();
    cimd.accepted(URL_);
    await cimd.granted(URL_);
    expect(records.size).toBe(0);
  });

  it.each([
    ['another client_id', () => Response.json({ ...DOC, client_id: 'https://evil.example/doc' })],
    ['a JWKS', () => Response.json({ keys: [] })],
    ['a non-JSON body', () => new Response('not json')],
    ['a 203', () => Response.json(DOC, { status: 203 })],
  ])('keeps nothing from %s', async (_, response) => {
    const { lastGood, records } = memoryLastGood();
    const { cimd } = setUp(sequence(response), lastGood);
    await signIn(cimd);
    expect(records.size).toBe(0);
  });

  it('forgets the oldest pending documents past a hundred', async () => {
    const { lastGood, records } = memoryLastGood();
    const docAt = (i: number) => `https://c${i}.example/doc`;
    const { cimd } = setUp(
      async (input) =>
        Response.json({ client_id: String(input), redirect_uris: ['https://x.example/cb'] }),
      lastGood,
    );
    for (let i = 0; i <= 100; i++) await cimd.fetch(docAt(i), {});
    // Fetched again, 1 is the newest: 101 pushes 2 out, not 1.
    await cimd.fetch(docAt(1), {});
    await cimd.fetch(docAt(101), {});
    for (let i = 0; i <= 101; i++) cimd.accepted(docAt(i));
    for (const i of [0, 1, 2, 3]) await cimd.granted(docAt(i));
    expect([...records.keys()]).toEqual([docAt(1), docAt(3)]);
  });

  it('forgets the oldest accepted documents past a hundred', async () => {
    const { lastGood, records } = memoryLastGood();
    const docAt = (i: number) => `https://c${i}.example/doc`;
    const { cimd } = setUp(
      async (input) =>
        Response.json({ client_id: String(input), redirect_uris: ['https://x.example/cb'] }),
      lastGood,
    );
    for (let i = 0; i <= 100; i++) {
      await cimd.fetch(docAt(i), {});
      cimd.accepted(docAt(i));
    }
    await cimd.granted(docAt(0));
    await cimd.granted(docAt(100));
    expect([...records.keys()]).toEqual([docAt(100)]);
  });

  it('serves the live document when keeping its copy fails', async () => {
    const lastGood: SealedCollection<CimdLastGood> = {
      get: async () => undefined,
      set: async () => {
        throw new Error('ENOSPC');
      },
      delete: async () => undefined,
    };
    const { cimd, events } = setUp(sequence(ok), lastGood);
    expect(await (await signIn(cimd)).json()).toEqual(NATIVE);
    expect(events).toEqual([
      ['warn', 'oauth_cimd_last_good_store_failed', { url: URL_, error: 'ENOSPC' }],
    ]);
  });
});

describe('createCimdDocuments: serving the copy', () => {
  it.each([403, 408, 429, 500, 502, 503])('serves the copy on a %i, and says so', async (code) => {
    const { cimd, events } = setUp(sequence(ok, status(code)));
    await signIn(cimd);
    vi.advanceTimersByTime(3600 * 1000);
    const res = await cimd.fetch(URL_, {});
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('max-age=60');
    expect(await res.json()).toEqual(NATIVE);
    expect(events).toEqual([failed({ status: code, fallback: 'last_good', ageS: 3600 })]);
  });

  it('releases the failed response it does not hand on', async () => {
    const failure = new Response('blocked', { status: 403 });
    const cancel = vi.spyOn(failure.body as ReadableStream, 'cancel');
    const { cimd } = setUp(sequence(ok, () => failure));
    await signIn(cimd);
    await cimd.fetch(URL_, {});
    expect(cancel).toHaveBeenCalled();
  });

  it('serves the copy in place of a failure without a body', async () => {
    const { cimd } = setUp(sequence(ok, () => new Response(null, { status: 503 })));
    await signIn(cimd);
    expect(await (await cimd.fetch(URL_, {})).json()).toEqual(NATIVE);
  });

  it('serves the copy on a network error, naming its cause', async () => {
    const { cimd, events } = setUp(sequence(ok, networkError));
    await signIn(cimd);
    expect(await (await cimd.fetch(URL_, {})).json()).toEqual(NATIVE);
    expect(events).toEqual([
      failed({
        error: 'fetch failed: getaddrinfo ENOTFOUND claude.ai',
        fallback: 'last_good',
        ageS: 0,
      }),
    ]);
  });

  it('serves the copy when the body cannot be read', async () => {
    const stalled = () =>
      new Response(
        new ReadableStream({
          pull: () => {
            throw new Error('aborted');
          },
        }),
      );
    const { cimd, events } = setUp(sequence(ok, stalled));
    await signIn(cimd);
    expect(await (await cimd.fetch(URL_, {})).json()).toEqual(NATIVE);
    expect(events).toEqual([failed({ error: 'aborted', fallback: 'last_good', ageS: 0 })]);
  });

  it('serves the copy in place of a 200 that is not the document', async () => {
    const challenge = new Response('<html>Just a moment...</html>', { status: 200 });
    const { cimd, events } = setUp(sequence(ok, () => challenge));
    await signIn(cimd);
    expect(await (await cimd.fetch(URL_, {})).json()).toEqual(NATIVE);
    expect(events).toEqual([
      failed({ status: 200, error: 'not a client document', fallback: 'last_good', ageS: 0 }),
    ]);
  });

  it('hands a non-document on as it came where no copy was kept', async () => {
    const { cimd, events } = setUp(sequence(() => Response.json({ keys: [{ kty: 'RSA' }] })));
    expect(await (await cimd.fetch('https://x/jwks', {})).json()).toEqual({
      keys: [{ kty: 'RSA' }],
    });
    expect(events).toEqual([]);
  });

  it.each([
    ['another client', () => Response.json({ ...DOC, client_id: 'https://evil.example/doc' })],
    ['a 203', () => Response.json(DOC, { status: 203 })],
  ])('serves the copy in place of a document for %s', async (_, response) => {
    const { cimd, events } = setUp(sequence(ok, response));
    await signIn(cimd);
    expect(await (await cimd.fetch(URL_, {})).json()).toEqual(NATIVE);
    expect(events).toHaveLength(1);
  });

  it.each([404, 410, 401, 400, 302])(
    'never falls back on a %i, and only says so at debug level',
    async (code) => {
      const failure = new Response('gone', { status: code });
      const { cimd, events } = setUp(sequence(ok, () => failure));
      await signIn(cimd);
      expect(await cimd.fetch(URL_, {})).toBe(failure);
      expect(events).toEqual([
        ['debug', 'oauth_client_fetch_failed', { url: URL_, status: code, fallback: 'none' }],
      ]);
    },
  );

  it('hands the failure on when no copy was kept', async () => {
    const failure = new Response('blocked', { status: 403 });
    const { cimd, events } = setUp(async () => failure);
    expect(await cimd.fetch(URL_, {})).toBe(failure);
    const { cimd: offline } = setUp(networkError);
    await expect(offline.fetch(URL_, {})).rejects.toThrow('fetch failed');
    const { cimd: odd, events: oddEvents } = setUp(() => Promise.reject('odd'));
    await expect(odd.fetch(URL_, {})).rejects.toBe('odd');
    expect(events).toEqual([failed({ status: 403, fallback: 'none' })]);
    expect(oddEvents).toEqual([failed({ error: 'odd', fallback: 'none' })]);
  });

  it('hands the failure on when reading the copy fails', async () => {
    const lastGood: SealedCollection<CimdLastGood> = {
      get: async () => {
        throw new Error('EIO');
      },
      set: async () => undefined,
      delete: async () => undefined,
    };
    const failure = new Response('blocked', { status: 403 });
    const { cimd, events } = setUp(async () => failure, lastGood);
    expect(await cimd.fetch(URL_, {})).toBe(failure);
    expect(events).toEqual([
      ['warn', 'oauth_cimd_last_good_read_failed', { url: URL_, error: 'EIO' }],
      failed({ status: 403, fallback: 'none' }),
    ]);
  });

  it('forgets the copy seven days after it was kept', async () => {
    const lastGood = createSealedCollection<CimdLastGood>(
      createMemoryStore(),
      'CimdDocument',
      deriveKeyRing(Buffer.alloc(32, 3).toString('base64')),
    );
    const { cimd } = setUp(sequence(ok, status(403)), lastGood);
    await signIn(cimd);
    vi.advanceTimersByTime(LAST_GOOD_TTL_S * 1000 - 1);
    expect((await cimd.fetch(URL_, {})).status).toBe(200);
    vi.advanceTimersByTime(1);
    expect((await cimd.fetch(URL_, {})).status).toBe(403);
  });
});

describe('CIMD_FETCH_HINT', () => {
  it('says what failed and where to read on', () => {
    expect(CIMD_FETCH_HINT).toMatchInlineSnapshot(
      `"A client document, or a URL it names, could not be fetched: the client cannot sign in or refresh unless a last good copy is served. See https://github.com/fruggr/zendesk-mcp-server/blob/main/docs/troubleshooting.md#http-the-log-shows-oauth_client_fetch_failed"`,
    );
  });

  it('points at a troubleshooting section that exists on main', () => {
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
