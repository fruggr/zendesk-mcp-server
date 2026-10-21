import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDiskStore,
  createMemoryStore,
  type StateStore,
  startSweeper,
} from '../../../src/utils/state-store';

const isWindows = process.platform === 'win32';

// The contract both stores honour, run against each with a controllable clock.
const contract = (name: string, make: (now: () => number) => StateStore) => {
  describe(`${name} store contract`, () => {
    let clock = 1_000_000;
    let store: StateStore;
    beforeEach(() => {
      clock = 1_000_000;
      store = make(() => clock);
    });

    it('returns undefined for a key never set', async () => {
      expect(await store.get('nope')).toBeUndefined();
    });

    it('round-trips a JSON value', async () => {
      await store.set('k', { a: [1, 'two'], b: null });
      expect(await store.get('k')).toEqual({ a: [1, 'two'], b: null });
    });

    it('keeps an entry without ttl forever', async () => {
      await store.set('k', 1);
      clock += 10 ** 12;
      expect(await store.get('k')).toBe(1);
    });

    it('expires an entry once its ttl has elapsed, not before', async () => {
      await store.set('k', 'v', 1000);
      clock += 999;
      expect(await store.get('k')).toBe('v');
      clock += 1;
      expect(await store.get('k')).toBeUndefined();
    });

    it('overwrites and deletes', async () => {
      await store.set('k', 1);
      await store.set('k', 2);
      expect(await store.get('k')).toBe(2);
      await store.delete('k');
      expect(await store.get('k')).toBeUndefined();
      await store.delete('k');
    });

    it('keeps keys apart', async () => {
      await store.set('prefs:1', 'one');
      await store.set('prefs:2', 'two');
      expect(await store.get('prefs:1')).toBe('one');
      expect(await store.get('prefs:2')).toBe('two');
    });

    it('sweeps expired entries and keeps live ones', async () => {
      await store.set('old', 1, 10);
      await store.set('live', 2, 1000);
      await store.set('forever', 3);
      clock += 500;
      expect(await store.sweep()).toBe(true);
      clock -= 500;
      expect(await store.get('old')).toBeUndefined();
      expect(await store.get('live')).toBe(2);
      expect(await store.get('forever')).toBe(3);
    });
  });
};

contract('memory', (now) => createMemoryStore(now));

describe('memory store', () => {
  it('reads the real clock by default', async () => {
    const store = createMemoryStore();
    await store.set('k', 1, 60_000);
    expect(await store.get('k')).toBe(1);
    await store.set('gone', 1, -1);
    expect(await store.get('gone')).toBeUndefined();
  });
});

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'sla-state-'));

contract('disk', (now) => createDiskStore(join(tempDir(), 'state'), { now }));

describe('disk store', () => {
  let dir: string;
  let clock: number;
  const now = () => clock;
  beforeEach(() => {
    dir = join(tempDir(), 'state');
    clock = 1_000_000;
  });

  it('shares entries between two stores on the same directory (two processes)', async () => {
    await createDiskStore(dir, { now }).set('prefs:1', { reply: '2h,30m' });
    expect(await createDiskStore(dir, { now }).get('prefs:1')).toEqual({ reply: '2h,30m' });
  });

  // Windows has no POSIX modes to check.
  describe.skipIf(isWindows)('permissions', () => {
    // The permission bits are the low nine of `mode`, in octal.
    const permissions = (path: string): number => statSync(path).mode % 0o1000;

    it('tightens a directory that already exists with a looser mode', async () => {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      chmodSync(dir, 0o755);
      await createDiskStore(dir, { now }).set('k', 1);
      expect(permissions(dir)).toBe(0o700);
    });

    it('creates the directory 0700 and each entry 0600', async () => {
      await createDiskStore(dir, { now }).set('k', 1);
      expect(permissions(dir)).toBe(0o700);
      const [file] = readdirSync(dir);
      expect(permissions(join(dir, file as string))).toBe(0o600);
    });
  });

  it('names files by a hash, never by the key, and leaves no temp file behind', async () => {
    await createDiskStore(dir, { now }).set('cache:42:query:status<solved', 1);
    const names = readdirSync(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f]{32}\.json$/);
  });

  it('stores the entry with its key and its own expiry', async () => {
    await createDiskStore(dir, { now }).set('k', 'v', 1000);
    const [file] = readdirSync(dir);
    expect(JSON.parse(readFileSync(join(dir, file as string), 'utf8'))).toEqual({
      key: 'k',
      value: 'v',
      expiresAt: 1_001_000,
    });
  });

  it('treats an entry carrying another key (a hash collision) as a miss', async () => {
    const store = createDiskStore(dir, { now });
    await store.set('k', 'v');
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file as string), JSON.stringify({ key: 'other', value: 'x' }));
    expect(await store.get('k')).toBeUndefined();
  });

  it('treats a file that is not an entry as a miss, not an error', async () => {
    const store = createDiskStore(dir, { now });
    await store.set('k', 'v');
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file as string), '{not json');
    expect(await store.get('k')).toBeUndefined();
  });

  it('fails a read the filesystem refuses, rather than calling it a miss', async () => {
    // A caller told "missing" would overwrite what it cannot read.
    const store = createDiskStore(dir, { now });
    await store.set('k', 'v');
    const [file] = readdirSync(dir);
    const path = join(dir, file as string);
    rmSync(path);
    mkdirSync(path);
    await expect(store.get('k')).rejects.toMatchObject({ code: 'EISDIR' });
    // A sweep steps over it.
    expect(await store.sweep()).toBe(true);
    expect(readdirSync(dir)).toEqual([file]);
  });

  it('reads a missing directory as an empty store, and sweeps it as done', async () => {
    const store = createDiskStore(dir, { now });
    expect(await store.get('k')).toBeUndefined();
    expect(await store.sweep()).toBe(true);
  });

  describe('sweep', () => {
    const lockPath = () => join(dir, 'cleanup.lock');

    it('deletes stale temp files and keeps fresh ones and foreign files', async () => {
      const store = createDiskStore(dir, { now: () => Date.now(), tempStaleMs: 60_000 });
      await store.set('k', 1);
      const stale = join(dir, 'a.json.1.x.tmp');
      const fresh = join(dir, 'b.json.1.y.tmp');
      writeFileSync(stale, '');
      writeFileSync(fresh, '');
      writeFileSync(join(dir, 'README'), '');
      const old = (Date.now() - 120_000) / 1000;
      utimesSync(stale, old, old);
      expect(await store.sweep()).toBe(true);
      expect(readdirSync(dir).sort()).toEqual(
        ['README', 'b.json.1.y.tmp', readdirSync(dir).find((n) => n.endsWith('.json'))].sort(),
      );
    });

    // `now` is injected and mtimes are set to whole seconds, so the boundary is exact.
    const ageTemp = (name: string, ageMs: number): void => {
      const path = join(dir, name);
      writeFileSync(path, '');
      const at = (clock - ageMs) / 1000;
      utimesSync(path, at, at);
    };

    it('keeps a temp file exactly as old as the limit and deletes one a millisecond older', async () => {
      clock = 1_700_000_000_000;
      const store = createDiskStore(dir, { now, tempStaleMs: 60_000 });
      await store.set('k', 1);
      ageTemp('kept.tmp', 60_000);
      ageTemp('gone.tmp', 61_000);
      await store.sweep();
      expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual(['kept.tmp']);
    });

    it('treats a temp file as abandoned after five minutes by default', async () => {
      clock = 1_700_000_000_000;
      const store = createDiskStore(dir, { now });
      await store.set('k', 1);
      ageTemp('kept.tmp', 300_000);
      ageTemp('gone.tmp', 301_000);
      await store.sweep();
      expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual(['kept.tmp']);
    });

    it('takes over a lock after two minutes by default, not before', async () => {
      const store = createDiskStore(dir, { now });
      await store.set('k', 1, 10);
      clock += 100;
      writeFileSync(lockPath(), JSON.stringify({ pid: 1, at: clock - 119_999 }));
      expect(await store.sweep()).toBe(false);
      writeFileSync(lockPath(), JSON.stringify({ pid: 1, at: clock - 120_000 }));
      expect(await store.sweep()).toBe(true);
    });

    it('gives up after one takeover attempt when the lock cannot be replaced', async () => {
      const store = createDiskStore(dir, { now });
      await store.set('k', 1);
      mkdirSync(lockPath());
      expect(await store.sweep()).toBe(false);
    });

    it('removes its lock when done', async () => {
      const store = createDiskStore(dir, { now });
      await store.set('k', 1, 10);
      clock += 100;
      await store.sweep();
      expect(readdirSync(dir)).toEqual([]);
    });

    it('stands back while another process holds a fresh lock', async () => {
      const store = createDiskStore(dir, { now, lockStaleMs: 120_000 });
      await store.set('k', 1, 10);
      clock += 100;
      writeFileSync(lockPath(), JSON.stringify({ pid: 1, at: clock - 119_999 }));
      expect(await store.sweep()).toBe(false);
      expect(readdirSync(dir)).toHaveLength(2);
    });

    it('takes over a lock older than the stale limit', async () => {
      const store = createDiskStore(dir, { now, lockStaleMs: 120_000 });
      await store.set('k', 1, 10);
      clock += 100;
      writeFileSync(lockPath(), JSON.stringify({ pid: 1, at: clock - 120_000 }));
      expect(await store.sweep()).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    });

    it('takes over a lock it cannot read', async () => {
      const store = createDiskStore(dir, { now });
      await store.set('k', 1);
      writeFileSync(lockPath(), 'garbage');
      expect(await store.sweep()).toBe(true);
      expect(readdirSync(dir)).not.toContain('cleanup.lock');
    });

    it('writes its pid and time into the lock while sweeping', async () => {
      const store = createDiskStore(dir, { now });
      await store.set('k', 1);
      let seen: unknown;
      const spy = vi.spyOn(JSON, 'parse').mockImplementation(function (this: unknown, text) {
        if (seen === undefined) seen = readFileSync(lockPath(), 'utf8');
        spy.mockRestore();
        return JSON.parse(text);
      });
      await store.sweep();
      expect(JSON.parse(seen as string)).toEqual({ pid: process.pid, at: clock });
    });
  });
});

describe('startSweeper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps on every interval, never at start, and stops', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(() => Promise.resolve(true));
    const stop = startSweeper({ ...createMemoryStore(), sweep }, 1000);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sweep).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sweep).toHaveBeenCalledTimes(3);
  });

  it('defaults to every ten minutes and survives a failing sweep', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(() => Promise.reject(new Error('disk gone')));
    const stop = startSweeper({ ...createMemoryStore(), sweep });
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    stop();
  });

  it('never keeps the process alive', () => {
    const unref = vi.fn();
    const spy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);
    startSweeper(createMemoryStore(), 1000);
    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });
});
