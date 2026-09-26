import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFileStore,
  createMemoryStore,
  type RecordStore,
  type StoredEntry,
} from '../../../../src/auth/server/file-store';
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

const hashed = (id: string) => createHash('sha256').update(id).digest('base64url');
type Entries = Map<string, StoredEntry>;
const keysOf = (entries: Entries) => [...entries.keys()].sort();
const expiresOf = (entries: Entries, key: string): unknown => {
  const entry = entries.get(key);
  return entry === undefined ? 'absent' : entry.exp;
};
// A fractional second, so Math.floor and Math.ceil disagree on it.
const NOW = 1_700_000_000_500;
const NOW_S = Math.floor(NOW / 1000);

// A backend whose writes and deletes on matching keys wait until released.
const holdableStore = () => {
  const data = new Map<string, string>();
  let held: { match: (key: string) => boolean; until: Promise<void> } | undefined;
  const wait = async (key: string) => {
    if (held?.match(key)) await held.until;
  };
  const store: RecordStore = {
    get: async (key) => data.get(key),
    set: async (key, value) => {
      await wait(key);
      data.set(key, value);
    },
    delete: async (key) => {
      await wait(key);
      data.delete(key);
    },
  };
  const hold = (match: (key: string) => boolean) => {
    let release = () => {};
    held = {
      match,
      until: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    return release;
  };
  return { store, hold };
};

const settlesSoon = (operation: Promise<unknown>) =>
  Promise.race([
    operation.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('still blocked'), 1000)),
  ]);

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
  let persistentEntries: Entries;
  let memoryEntries: Entries;
  let persistent: RecordStore;
  let memory: RecordStore;

  beforeEach(() => {
    persistentEntries = new Map();
    memoryEntries = new Map();
    persistent = createMemoryStore(persistentEntries);
    memory = createMemoryStore(memoryEntries);
  });

  const adapterFor = (name: string, secret = OLD) =>
    createAdapterFactory({ persistent, memory }, deriveKeyRing(secret))(name);

  it('routes persistent models to the persistent store and the rest to memory', async () => {
    await adapterFor('RefreshToken').upsert('rt-1', { grantId: 'g', exp: futureExp(60) }, 60);
    await adapterFor('Session').upsert('s-1', { uid: 'u' }, 60);
    expect(keysOf(persistentEntries).some((k) => k.includes('RefreshToken:'))).toBe(true);
    expect(keysOf(persistentEntries).some((k) => k.includes('Session:'))).toBe(false);
    expect(keysOf(memoryEntries).some((k) => k.includes('Session:'))).toBe(true);
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
    const dump = JSON.stringify([...persistentEntries]);
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

describe('createAdapterFactory, key layout and expiry', () => {
  let persistentEntries: Entries;
  let memoryEntries: Entries;
  let persistent: RecordStore;
  let memory: RecordStore;
  const ring = deriveKeyRing(OLD);

  beforeEach(() => {
    persistentEntries = new Map();
    memoryEntries = new Map();
    persistent = createMemoryStore(persistentEntries);
    memory = createMemoryStore(memoryEntries);
  });
  afterEach(() => vi.useRealTimers());

  const adapterFor = (name: string) => createAdapterFactory({ persistent, memory }, ring)(name);
  const grantIndexOf = (grantId: string) =>
    createSealedCollection<unknown>(persistent, 'RefreshToken:grant', ring).get(grantId);

  it('keys records as <model>:<sha256 of the id>, with per-model grant and uid indexes', async () => {
    await adapterFor('RefreshToken').upsert('rt-1', { grantId: 'g-1', exp: futureExp(60) }, 60);
    await adapterFor('Session').upsert('s-1', { uid: 'u-1' }, 60);
    expect(keysOf(persistentEntries)).toEqual(
      [`RefreshToken:${hashed('rt-1')}`, `RefreshToken:grant:${hashed('g-1')}`].sort(),
    );
    expect(keysOf(memoryEntries)).toEqual(
      [`Session:${hashed('s-1')}`, `Session:uid:${hashed('u-1')}`].sort(),
    );
  });

  it('drops the grant index along with the records it revokes', async () => {
    const adapter = adapterFor('RefreshToken');
    await adapter.upsert('rt-1', { grantId: 'g-1', exp: futureExp(60) }, 60);
    await adapter.revokeByGrantId('g-1');
    expect(keysOf(persistentEntries)).toEqual([]);
  });

  it('indexes a grant until its latest expiry, never shortening it', async () => {
    vi.useFakeTimers({ now: NOW });
    const adapter = adapterFor('RefreshToken');
    await adapter.upsert('a', { grantId: 'g', exp: NOW_S + 60 }, 60);
    expect(await grantIndexOf('g')).toEqual({ ids: ['a'], exp: NOW_S + 60 });
    expect(expiresOf(persistentEntries, `RefreshToken:grant:${hashed('g')}`)).toBe(NOW + 60_000);

    await adapter.upsert('b', { grantId: 'g', exp: NOW_S + 120 }, 120);
    await adapter.upsert('c', { grantId: 'g', exp: NOW_S + 30 }, 30);
    expect(await grantIndexOf('g')).toEqual({ ids: ['a', 'b', 'c'], exp: NOW_S + 120 });
    expect(expiresOf(persistentEntries, `RefreshToken:grant:${hashed('g')}`)).toBe(NOW + 120_000);
  });

  it('indexes a grant with no expiry forever, and one already expired for a second', async () => {
    vi.useFakeTimers({ now: NOW });
    const adapter = adapterFor('RefreshToken');
    await adapter.upsert('a', { grantId: 'forever' });
    expect(await grantIndexOf('forever')).toEqual({ ids: ['a'] });
    expect(expiresOf(persistentEntries, `RefreshToken:grant:${hashed('forever')}`)).toBeUndefined();

    await adapter.upsert('b', { grantId: 'past', exp: NOW_S - 10 });
    expect(expiresOf(persistentEntries, `RefreshToken:grant:${hashed('past')}`)).toBe(NOW + 1000);
  });

  it('consumes a token in place, stamping the time and keeping its expiry', async () => {
    vi.useFakeTimers({ now: NOW });
    const adapter = adapterFor('RefreshToken');
    await adapter.upsert('rt', { grantId: 'g', exp: NOW_S + 60 }, 60);
    vi.setSystemTime(NOW + 10_000);
    await adapter.consume('rt');
    expect(await adapter.find('rt')).toEqual({
      grantId: 'g',
      exp: NOW_S + 60,
      consumed: NOW_S + 10,
    });
    // 49.5 s were left: rounded up to whole seconds, the record outlives its exp by 0.5 s.
    expect(expiresOf(persistentEntries, `RefreshToken:${hashed('rt')}`)).toBe(NOW + 60_000);
  });

  it('creates nothing when consuming an unknown token', async () => {
    const adapter = adapterFor('RefreshToken');
    await adapter.consume('missing');
    expect(await adapter.find('missing')).toBeUndefined();
    expect(keysOf(persistentEntries)).toEqual([]);
  });

  it('serialises index updates per grant, so a stalled grant never blocks another', async () => {
    const { store, hold } = holdableStore();
    const adapter = createAdapterFactory({ persistent: store, memory }, ring)('RefreshToken');
    await adapter.upsert('x', { grantId: 'g2', exp: futureExp(60) }, 60);
    const release = hold((key) => key.endsWith(`:${hashed('g1')}`));
    const stalled = adapter.upsert('a', { grantId: 'g1', exp: futureExp(60) }, 60);
    expect(await settlesSoon(adapter.upsert('b', { grantId: 'g2', exp: futureExp(60) }, 60))).toBe(
      'settled',
    );
    expect(await settlesSoon(adapter.revokeByGrantId('g2'))).toBe('settled');
    release();
    await stalled;
    expect(await adapter.find('a')).toBeDefined();
    expect(await adapter.find('b')).toBeUndefined();
  });

  it('lets a revocation through while another grant is being revoked', async () => {
    const { store, hold } = holdableStore();
    const adapter = createAdapterFactory({ persistent: store, memory }, ring)('RefreshToken');
    await adapter.upsert('a', { grantId: 'g1', exp: futureExp(60) }, 60);
    await adapter.upsert('b', { grantId: 'g2', exp: futureExp(60) }, 60);
    const release = hold((key) => key.endsWith(`:${hashed('g1')}`));
    const stalled = adapter.revokeByGrantId('g1');
    expect(await settlesSoon(adapter.revokeByGrantId('g2'))).toBe('settled');
    release();
    await stalled;
    expect(await adapter.find('a')).toBeUndefined();
    expect(await adapter.find('b')).toBeUndefined();
  });
});

describe('createSealedCollection', () => {
  it('treats a tampered or foreign value as absent', async () => {
    const entries: Entries = new Map();
    const store = createMemoryStore(entries);
    const ring = deriveKeyRing(OLD);
    const collection = createSealedCollection<{ a: number }>(store, 'Thing', ring);
    await collection.set('x', { a: 1 });
    expect(keysOf(entries)).toEqual([`Thing:${hashed('x')}`]);
    await store.set(`Thing:${hashed('x')}`, 'not-a-jwe');
    expect(await collection.get('x')).toBeUndefined();
  });

  it('keeps its expiry when re-encrypting a record under the current secret', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const entries: Entries = new Map();
      const store = createMemoryStore(entries);
      const key = `Thing:${hashed('x')}`;
      const write = createSealedCollection<unknown>(store, 'Thing', deriveKeyRing(OLD));
      const rotate = createSealedCollection<unknown>(
        store,
        'Thing',
        deriveKeyRing(`${NEW},${OLD}`),
      );

      await write.set('x', { exp: NOW_S + 60 }, 60);
      expect(await rotate.get('x')).toEqual({ exp: NOW_S + 60 });
      expect(expiresOf(entries, key)).toBe((NOW_S + 60) * 1000);

      await write.set('x', { exp: NOW_S - 10 });
      await rotate.get('x');
      expect(expiresOf(entries, key)).toBe(NOW + 1);

      await write.set('x', { exp: '5' });
      await rotate.get('x');
      expect(expiresOf(entries, key)).toBeUndefined();

      await write.set('x', null);
      expect(await rotate.get('x')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires a record after its ttl', async () => {
    vi.useFakeTimers();
    try {
      const collection = createSealedCollection<string>(
        createMemoryStore(),
        'Thing',
        deriveKeyRing(OLD),
      );
      await collection.set('x', 'v', 10);
      expect(await collection.get('x')).toBe('v');
      vi.advanceTimersByTime(9_000);
      expect(await collection.get('x')).toBe('v');
      vi.advanceTimersByTime(2_000);
      expect(await collection.get('x')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // A store outage must not read as every grant being gone: clients would drop
  // their tokens. Raised, it is a 500 the client retries.
  it('raises a backend failure instead of reading it as a missing record', async () => {
    const down: RecordStore = {
      get: () => Promise.reject(new Error('backend down')),
      set: () => Promise.reject(new Error('backend down on write')),
      delete: () => Promise.reject(new Error('backend down on delete')),
    };
    const collection = createSealedCollection<string>(down, 'Thing', deriveKeyRing(OLD));
    await expect(collection.get('x')).rejects.toThrow('backend down');
    await expect(collection.set('x', 'v')).rejects.toThrow('backend down on write');
    await expect(collection.delete('x')).rejects.toThrow('backend down on delete');
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
    const first = createFileStore(path);
    await first.set('k', 'v');
    if (process.platform !== 'win32') {
      expect((statSync(path).mode % 0o1000).toString(8)).toBe('600');
    }
    const second = createFileStore(path);
    expect(await second.get('k')).toBe('v');
    await second.delete('k');
    expect(await createFileStore(path).get('k')).toBeUndefined();
  });

  it('drops expired entries on load', async () => {
    const path = join(dir, 'store.json');
    writeFileSync(
      path,
      JSON.stringify({
        gone: { v: 'x', exp: Date.now() - 1 },
        kept: { v: 'y', exp: Date.now() + 60_000 },
        forever: { v: 'z' },
      }),
    );
    const store = createFileStore(path);
    expect(await store.get('gone')).toBeUndefined();
    expect(await store.get('kept')).toBe('y');
    expect(await store.get('forever')).toBe('z');
    await store.set('touch', '1');
    expect(readFileSync(path, 'utf8')).not.toContain('gone');
  });

  it('refuses a corrupt file instead of silently starting empty', () => {
    const path = join(dir, 'store.json');
    writeFileSync(path, '{"truncated');
    expect(() => createFileStore(path)).toThrow();
    writeFileSync(path, '[]');
    expect(() => createFileStore(path)).toThrow('The OAuth store file is not a JSON object.');
  });
});

describe('openStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zmcp-open-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('opens memory:// in memory, a fresh store each time', async () => {
    const memory = openStore('memory://');
    await memory.set('a', '1');
    expect(await memory.get('a')).toBe('1');
    expect(await openStore('memory://').get('a')).toBeUndefined();
  });

  it('opens file:// as the file at that path, which survives a reopen', async () => {
    const path = join(dir, 'my store.json');
    const file = openStore(pathToFileURL(path).href);
    await file.set('b', '2');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ b: { v: '2' } });
    expect(await openStore(pathToFileURL(path).href).get('b')).toBe('2');
  });

  it.each([
    'redis://localhost:6379',
    'rediss://localhost:6380',
    'postgres://u@h/db',
    'postgresql://u@h/db',
    'sqlite:///tmp/x.sqlite',
    'ftp://x',
  ])('rejects %s, naming the schemes it supports', (uri) => {
    const scheme = `${new URL(uri).protocol}`;
    expect(() => openStore(uri)).toThrow(
      new Error(`Unsupported OAuth store scheme "${scheme}". Use file:// or memory://.`),
    );
  });
});
