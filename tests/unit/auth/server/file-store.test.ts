import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFileStore,
  createMemoryStore,
  type StoredEntry,
} from '../../../../src/auth/server/file-store';

const modeOf = (path: string) => (statSync(path).mode % 0o1000).toString(8);
const onWindows = process.platform === 'win32';
const NOW = 1_700_000_000_000;

describe('createMemoryStore', () => {
  afterEach(() => vi.useRealTimers());

  it('works without a map of its own', async () => {
    const store = createMemoryStore();
    expect(await store.get('k')).toBeUndefined();
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
    await store.delete('k');
    expect(await store.get('k')).toBeUndefined();
  });

  it('stores a record without a ttl as its value alone, never expiring', async () => {
    vi.useFakeTimers({ now: NOW });
    const entries = new Map<string, StoredEntry>();
    const store = createMemoryStore(entries);
    await store.set('k', 'v');
    expect([...entries]).toStrictEqual([['k', { v: 'v' }]]);
    vi.setSystemTime(Number.MAX_SAFE_INTEGER);
    expect(await store.get('k')).toBe('v');
  });

  it('stamps a ttl as the epoch ms the record expires at', async () => {
    vi.useFakeTimers({ now: NOW });
    const entries = new Map<string, StoredEntry>();
    const store = createMemoryStore(entries);
    await store.set('k', 'v', 1500);
    await store.set('zero', 'z', 0);
    expect([...entries]).toStrictEqual([
      ['k', { v: 'v', exp: NOW + 1500 }],
      ['zero', { v: 'z', exp: NOW }],
    ]);
  });

  it('answers a record until the millisecond it expires, then nothing', async () => {
    vi.useFakeTimers({ now: NOW });
    const store = createMemoryStore();
    await store.set('k', 'v', 1000);
    await store.set('zero', 'z', 0);
    expect(await store.get('zero')).toBeUndefined();
    vi.setSystemTime(NOW + 999);
    expect(await store.get('k')).toBe('v');
    vi.setSystemTime(NOW + 1000);
    expect(await store.get('k')).toBeUndefined();
  });

  it('overwrites a record, dropping its old expiry', async () => {
    vi.useFakeTimers({ now: NOW });
    const entries = new Map<string, StoredEntry>();
    const store = createMemoryStore(entries);
    await store.set('k', 'old', 10);
    await store.set('k', 'new');
    expect(entries.get('k')).toStrictEqual({ v: 'new' });
  });

  it('reports every write, and a delete only when it removed something', async () => {
    const onChange = vi.fn();
    const entries = new Map<string, StoredEntry>();
    const store = createMemoryStore(entries, onChange);
    await store.get('k');
    await store.delete('k');
    expect(onChange).not.toHaveBeenCalled();
    await store.set('k', 'v');
    await store.set('k', 'w', 60_000);
    expect(onChange).toHaveBeenCalledTimes(2);
    await store.delete('k');
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(entries.size).toBe(0);
    await store.delete('k');
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('reports a write after it landed in the map', async () => {
    const entries = new Map<string, StoredEntry>();
    const seen: unknown[] = [];
    const store = createMemoryStore(entries, () => seen.push(entries.get('k')));
    await store.set('k', 'v');
    expect(seen).toStrictEqual([{ v: 'v' }]);
  });
});

describe('createFileStore', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zmcp-file-store-'));
    path = join(dir, 'store.json');
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = (entries: Record<string, unknown>) => writeFileSync(path, JSON.stringify(entries));
  const onDisk = () => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  // A crashed write leaves its temp file behind, and writeFileSync keeps an existing file's mode.
  const leaveStaleTempFile = () => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, '{}');
    chmodSync(tmp, 0o644);
  };

  it('writes each record as {"v": value, "exp": epoch ms}, exp only when it expires', async () => {
    vi.useFakeTimers({ now: NOW });
    const store = createFileStore(path);
    await store.set('k', '1');
    await store.set('t', '2', 1000);
    expect(readFileSync(path, 'utf8')).toBe(`{"k":{"v":"1"},"t":{"v":"2","exp":${NOW + 1000}}}`);
  });

  it('renames its temp file into place, leaving none behind', async () => {
    await createFileStore(path).set('k', 'v');
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
    expect(onDisk()).toEqual({ k: { v: 'v' } });
  });

  it('starts empty when the file does not exist, and creates it on the first write only', async () => {
    const store = createFileStore(path);
    expect(await store.get('k')).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    await store.set('k', 'v');
    expect(existsSync(path)).toBe(true);
  });

  it('reads back what an earlier instance wrote', async () => {
    vi.useFakeTimers({ now: NOW });
    const first = createFileStore(path);
    await first.set('k', 'v', 60_000);
    await first.set('forever', 'f');
    const second = createFileStore(path);
    expect(await second.get('k')).toBe('v');
    expect(await second.get('forever')).toBe('f');
    vi.setSystemTime(NOW + 60_000);
    expect(await second.get('k')).toBeUndefined();
  });

  // POSIX modes only mean something off Windows; the Windows branch is exercised by pretending.
  describe.skipIf(onWindows)('file modes', () => {
    it('creates missing parent directories owner-only', async () => {
      const nested = join(dir, 'a', 'b', 'store.json');
      const store = createFileStore(nested);
      await store.set('k', '1');
      await store.set('k', '2');
      expect(modeOf(join(dir, 'a'))).toBe('700');
      expect(modeOf(join(dir, 'a', 'b'))).toBe('700');
      expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ k: { v: '2' } });
    });

    it('writes the file owner-only', async () => {
      await createFileStore(path).set('k', 'v');
      expect(modeOf(path)).toBe('600');
    });

    it('resets a stale temp file to owner-only before renaming it', async () => {
      leaveStaleTempFile();
      await createFileStore(path).set('k', 'v');
      expect(modeOf(path)).toBe('600');
    });
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const loadAsWindows = async () => {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      try {
        vi.resetModules();
        return (await import('../../../../src/auth/server/file-store')).createFileStore;
      } finally {
        if (platform) Object.defineProperty(process, 'platform', platform);
      }
    };

    it('relies on the creation mode alone on Windows', async () => {
      await (await loadAsWindows())(path).set('k', 'v');
      expect(modeOf(path)).toBe('600');
    });

    it('skips the POSIX chmod on Windows', async () => {
      leaveStaleTempFile();
      await (await loadAsWindows())(path).set('k', 'v');
      expect(modeOf(path)).toBe('644');
    });
  });

  it('refuses a store path it cannot read, naming the error code', () => {
    let error: unknown;
    try {
      createFileStore(dir);
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({
      message: 'Cannot read the OAuth store file (EISDIR).',
      cause: { code: 'EISDIR' },
    });
  });

  it('refuses a file that is not JSON instead of starting empty', () => {
    writeFileSync(path, '{"truncated');
    expect(() => createFileStore(path)).toThrow(SyntaxError);
  });

  it.each(['null', '0', '"text"', 'true', '[]'])('refuses %s as the file content', (content) => {
    writeFileSync(path, content);
    expect(() => createFileStore(path)).toThrow(
      new Error('The OAuth store file is not a JSON object.'),
    );
  });

  it('keeps on load exactly the well-formed entries that have not expired', async () => {
    vi.useFakeTimers({ now: NOW });
    seed({
      past: { v: 'a', exp: NOW - 1 },
      exactlyNow: { v: 'b', exp: NOW },
      future: { v: 'c', exp: NOW + 1 },
      noExpiry: { v: 'd' },
      numberValue: { v: 7 },
      noValue: { exp: NOW + 1 },
      // Would pass a coercing `>` against the clock: only a number is an expiry.
      stringExpiry: { v: 'e', exp: String(NOW + 60_000) },
      nullExpiry: { v: 'f', exp: null },
      nullEntry: null,
      plainString: 'plain',
      plainNumber: 7,
    });
    const store = createFileStore(path);
    await store.set('touch', 'x');
    expect(Object.keys(onDisk()).sort()).toEqual(['future', 'noExpiry', 'touch']);
    for (const key of ['numberValue', 'stringExpiry', 'nullExpiry', 'plainString']) {
      expect(await store.get(key)).toBeUndefined();
    }
    expect(await store.get('future')).toBe('c');
    expect(await store.get('noExpiry')).toBe('d');
  });

  it('forgets on load an entry that has expired, rather than only hiding it', async () => {
    vi.useFakeTimers({ now: NOW });
    seed({ gone: { v: 'x', exp: NOW } });
    const before = readFileSync(path, 'utf8');
    const store = createFileStore(path);
    // Held in memory, the delete would rewrite the file; forgotten, there is nothing to delete.
    await store.delete('gone');
    expect(readFileSync(path, 'utf8')).toBe(before);
    // Not merely filtered by the clock: it stays gone when the clock turns back.
    vi.setSystemTime(NOW - 1000);
    expect(await store.get('gone')).toBeUndefined();
  });

  it('drops on write the records that expired since they were loaded', async () => {
    vi.useFakeTimers({ now: NOW });
    const store = createFileStore(path);
    await store.set('short', 's', 1000);
    await store.set('long', 'l', 2000);
    vi.setSystemTime(NOW + 1000);
    await store.set('touch', 't');
    expect(onDisk()).toEqual({ long: { v: 'l', exp: NOW + 2000 }, touch: { v: 't' } });
  });

  it('writes nothing when deleting a key it does not hold', async () => {
    const store = createFileStore(path);
    await store.delete('missing');
    expect(existsSync(path)).toBe(false);
    await store.set('k', 'v');
    await store.delete('k');
    expect(onDisk()).toEqual({});
    expect(await createFileStore(path).get('k')).toBeUndefined();
  });
});
