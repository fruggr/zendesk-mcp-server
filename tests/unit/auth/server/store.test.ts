import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Keyv from 'keyv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileStore } from '../../../../src/auth/server/file-store';
import { deriveKeyRing } from '../../../../src/auth/server/keys';
import {
  createAdapterFactory,
  createSealedCollection,
  openStore,
  PERSISTENT_MODELS,
} from '../../../../src/auth/server/store';

const OLD = Buffer.alloc(32, 1).toString('base64');
const NEW = Buffer.alloc(32, 2).toString('base64');

const futureExp = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

describe('PERSISTENT_MODELS', () => {
  it('persists only what must survive a restart', () => {
    expect([...PERSISTENT_MODELS].sort()).toEqual([
      'Client',
      'Grant',
      'RefreshToken',
      'ZendeskTokens',
    ]);
  });
});

describe('createAdapterFactory', () => {
  let persistent: Keyv;
  let memory: Keyv;

  beforeEach(() => {
    persistent = new Keyv();
    memory = new Keyv();
  });

  const adapterFor = (name: string, secret = OLD) =>
    createAdapterFactory({ persistent, memory }, deriveKeyRing(secret))(name);

  it('routes persistent models to the persistent store and the rest to memory', async () => {
    await adapterFor('RefreshToken').upsert('rt-1', { grantId: 'g', exp: futureExp(60) }, 60);
    await adapterFor('Session').upsert('s-1', { uid: 'u' }, 60);
    expect(
      [...(persistent.store as Map<string, unknown>).keys()].some((k) =>
        k.includes('RefreshToken:'),
      ),
    ).toBe(true);
    expect(
      [...(persistent.store as Map<string, unknown>).keys()].some((k) => k.includes('Session:')),
    ).toBe(false);
    expect(
      [...(memory.store as Map<string, unknown>).keys()].some((k) => k.includes('Session:')),
    ).toBe(true);
  });

  it('round-trips a payload', async () => {
    const adapter = adapterFor('Client');
    await adapter.upsert('client-1', {
      client_id: 'client-1',
      redirect_uris: ['https://a.example/cb'],
    });
    expect(await adapter.find('client-1')).toEqual({
      client_id: 'client-1',
      redirect_uris: ['https://a.example/cb'],
    });
    expect(await adapter.find('unknown')).toBeUndefined();
  });

  it('stores neither the raw id nor any plaintext', async () => {
    await adapterFor('RefreshToken').upsert(
      'raw-refresh-token-value',
      { grantId: 'grant-xyz', accountId: 'zendesk:4242', exp: futureExp(60) },
      60,
    );
    const dump = JSON.stringify([...(persistent.store as Map<string, unknown>).entries()]);
    for (const secret of ['raw-refresh-token-value', 'grant-xyz', 'zendesk:4242', '4242']) {
      expect(dump).not.toContain(secret);
    }
  });

  it('marks a token consumed and keeps it readable', async () => {
    const adapter = adapterFor('RefreshToken');
    await adapter.upsert('rt-1', { grantId: 'g', exp: futureExp(60) }, 60);
    await adapter.consume('rt-1');
    expect(await adapter.find('rt-1')).toMatchObject({
      grantId: 'g',
      consumed: expect.any(Number),
    });
    await expect(adapter.consume('missing')).resolves.toBeUndefined();
  });

  it('destroys a record', async () => {
    const adapter = adapterFor('Grant');
    await adapter.upsert('g-1', { accountId: 'a' }, 60);
    await adapter.destroy('g-1');
    expect(await adapter.find('g-1')).toBeUndefined();
  });

  it('finds by uid', async () => {
    const adapter = adapterFor('Session');
    await adapter.upsert('sess-1', { uid: 'uid-1', accountId: 'a' }, 60);
    expect(await adapter.findByUid('uid-1')).toMatchObject({ accountId: 'a' });
    expect(await adapter.findByUid('nope')).toBeUndefined();
    expect(await adapter.findByUserCode('any')).toBeUndefined();
  });

  it('revokes every record of a grant, and only those, even when written concurrently', async () => {
    const adapter = adapterFor('RefreshToken');
    await Promise.all(
      ['a', 'b', 'c'].map((id) => adapter.upsert(id, { grantId: 'g1', exp: futureExp(60) }, 60)),
    );
    await adapter.upsert('other', { grantId: 'g2', exp: futureExp(60) }, 60);
    await adapter.revokeByGrantId('g1');
    expect(await adapter.find('a')).toBeUndefined();
    expect(await adapter.find('b')).toBeUndefined();
    expect(await adapter.find('c')).toBeUndefined();
    expect(await adapter.find('other')).toBeDefined();
    await expect(adapter.revokeByGrantId('never-seen')).resolves.toBeUndefined();
  });

  it('reads records under an older secret while it is still listed, and rejects them once dropped', async () => {
    await adapterFor('Client', OLD).upsert('c', { client_id: 'c' });
    expect(await adapterFor('RefreshToken', OLD).find('c')).toBeUndefined();
    expect(await adapterFor('Client', `${NEW},${OLD}`).find('c')).toEqual({ client_id: 'c' });
    await adapterFor('Client', OLD).upsert('stale', { client_id: 'stale' });
    expect(await adapterFor('Client', NEW).find('stale')).toBeUndefined();
  });

  it('re-encrypts a record read under an older secret, so dropping that secret loses nothing', async () => {
    await adapterFor('Client', OLD).upsert('c', { client_id: 'c' });
    await adapterFor('Client', `${NEW},${OLD}`).find('c');
    expect(await adapterFor('Client', NEW).find('c')).toEqual({ client_id: 'c' });
  });
});

describe('createSealedCollection', () => {
  it('treats a tampered or foreign value as absent', async () => {
    const store = new Keyv();
    const ring = deriveKeyRing(OLD);
    const collection = createSealedCollection<{ a: number }>(store, 'Thing', ring);
    await collection.set('x', { a: 1 });
    const [[key]] = [...(store.store as Map<string, unknown>).entries()] as [[string, unknown]];
    await store.set(key.replace(/^keyv:/, ''), 'not-a-jwe');
    expect(await collection.get('x')).toBeUndefined();
  });

  it('expires a record after its ttl', async () => {
    vi.useFakeTimers();
    try {
      const collection = createSealedCollection<string>(new Keyv(), 'Thing', deriveKeyRing(OLD));
      await collection.set('x', 'v', 10);
      expect(await collection.get('x')).toBe('v');
      vi.advanceTimersByTime(11_000);
      expect(await collection.get('x')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('file store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zmcp-store-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('survives a restart and writes owner-only files', async () => {
    const path = join(dir, 'nested', 'store.json');
    const first = new Keyv({ store: createFileStore(path) });
    await first.set('k', 'v');
    if (process.platform !== 'win32') {
      expect((statSync(path).mode % 0o1000).toString(8)).toBe('600');
    }
    const second = new Keyv({ store: createFileStore(path) });
    expect(await second.get('k')).toBe('v');
    await second.delete('k');
    expect(await new Keyv({ store: createFileStore(path) }).get('k')).toBeUndefined();
  });

  it('drops expired entries on load', async () => {
    const path = join(dir, 'store.json');
    writeFileSync(
      path,
      JSON.stringify({
        'keyv:gone': JSON.stringify({ value: 'x', expires: Date.now() - 1 }),
        'keyv:kept': JSON.stringify({ value: 'y', expires: Date.now() + 60_000 }),
        'keyv:forever': JSON.stringify({ value: 'z' }),
      }),
    );
    const store = new Keyv({ store: createFileStore(path) });
    expect(await store.get('kept')).toBe('y');
    expect(await store.get('forever')).toBe('z');
    await store.set('touch', 1);
    expect(readFileSync(path, 'utf8')).not.toContain('keyv:gone');
  });

  it('refuses a corrupt file instead of silently starting empty', () => {
    const path = join(dir, 'store.json');
    writeFileSync(path, '{"truncated');
    expect(() => createFileStore(path)).toThrow();
    writeFileSync(path, '[]');
    expect(() => createFileStore(path)).toThrow('The OAuth store file is not a JSON object.');
  });

  it('clears everything', async () => {
    const path = join(dir, 'store.json');
    const store = new Keyv({ store: createFileStore(path) });
    await store.set('a', 1);
    await store.clear();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});
  });
});

describe('openStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zmcp-open-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('opens memory:// and file:// without any extra package', async () => {
    const memory = await openStore('memory://');
    await memory.set('a', 1);
    expect(await memory.get('a')).toBe(1);
    const file = await openStore(pathToFileURL(join(dir, 'store.json')).href);
    await file.set('b', 2);
    expect(await (await openStore(pathToFileURL(join(dir, 'store.json')).href)).get('b')).toBe(2);
  });

  it('names the missing package for an optional scheme', async () => {
    await expect(openStore('redis://localhost:6379')).rejects.toThrow(
      'The OAuth store needs the package "@keyv/redis". Install it next to the server (npm install @keyv/redis).',
    );
    await expect(openStore('postgres://u@h/db')).rejects.toThrow('"@keyv/postgres"');
    await expect(openStore('sqlite:///tmp/x.sqlite')).rejects.toThrow('"@keyv/sqlite"');
  });

  it('raises a backend failure instead of reading it as a missing record', async () => {
    const pkg = join(dir, 'down-store.mjs');
    writeFileSync(
      pkg,
      `export default class { constructor() { this.opts = {}; } on() { return this; }
        async get() { throw new Error('backend down'); } async set() {} async delete() { return false; }
        async clear() {} }`,
    );
    const store = await openStore('custom://down', pathToFileURL(pkg).href);
    await expect(store.get('k')).rejects.toThrow('backend down');
  });

  it('rejects an unknown scheme', async () => {
    await expect(openStore('ftp://x')).rejects.toThrow('Unsupported OAuth store scheme "ftp:".');
  });

  it('loads a third-party adapter package and passes it the URI', async () => {
    const pkg = join(dir, 'custom-store.mjs');
    writeFileSync(
      pkg,
      `export default class { constructor(uri) { this.opts = { uri }; this.m = new Map(); }
        on() { return this; } async get(k) { return this.m.get(k); } async set(k, v) { this.m.set(k, v); }
        async delete(k) { return this.m.delete(k); } async clear() { this.m.clear(); } }`,
    );
    const store = await openStore('custom://somewhere', pathToFileURL(pkg).href);
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
    expect((store.store as { opts: { uri: string } }).opts.uri).toBe('custom://somewhere');
  });

  it('rejects an adapter package without a default-exported class', async () => {
    const pkg = join(dir, 'bad-store.mjs');
    writeFileSync(pkg, 'export const notAStore = 1;');
    await expect(openStore('custom://x', pathToFileURL(pkg).href)).rejects.toThrow(
      'The OAuth store adapter package has no default-exported Keyv store class.',
    );
  });
});
