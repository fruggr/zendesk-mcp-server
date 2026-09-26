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
import { createFileStore } from '../../../../src/auth/server/file-store';

const modeOf = (path: string) => (statSync(path).mode % 0o1000).toString(8);
const onWindows = process.platform === 'win32';

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

  it('exposes the file path as its adapter options', () => {
    expect(createFileStore(path).opts).toEqual({ path });
  });

  it('returns itself from on(), since it never emits', () => {
    const store = createFileStore(path);
    expect(store.on('error', () => undefined)).toBe(store);
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
      expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ k: '2' });
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

  it.each(['null', '0', '"text"', 'true', '[]'])('refuses %s as the file content', (content) => {
    writeFileSync(path, content);
    expect(() => createFileStore(path)).toThrow(
      new Error('The OAuth store file is not a JSON object.'),
    );
  });

  it('keeps on load exactly the string entries that have not expired', async () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers({ now });
    seed({
      past: JSON.stringify({ value: 1, expires: now - 1 }),
      exactlyNow: JSON.stringify({ value: 2, expires: now }),
      future: JSON.stringify({ value: 3, expires: now + 1 }),
      stringExpiry: JSON.stringify({ value: 4, expires: '0' }),
      nullExpiry: JSON.stringify({ value: 5, expires: null }),
      noExpiry: JSON.stringify({ value: 6 }),
      notJson: 'plain',
      notString: 7,
    });
    const store = createFileStore(path);
    await store.set('touch', 'x');
    expect(Object.keys(onDisk()).sort()).toEqual([
      'future',
      'noExpiry',
      'notJson',
      'nullExpiry',
      'stringExpiry',
      'touch',
    ]);
    expect(await store.get('notString')).toBeUndefined();
    expect(await store.get('notJson')).toBe('plain');
  });

  it('writes nothing when deleting a key it does not hold', async () => {
    const store = createFileStore(path);
    expect(await store.delete('missing')).toBe(false);
    expect(existsSync(path)).toBe(false);
    await store.set('k', 'v');
    expect(await store.delete('k')).toBe(true);
    expect(onDisk()).toEqual({});
  });

  it('persists a clear', async () => {
    const store = createFileStore(path);
    await store.set('a', '1');
    await store.clear();
    expect(onDisk()).toEqual({});
    expect(await store.get('a')).toBeUndefined();
    expect(await createFileStore(path).get('a')).toBeUndefined();
  });
});
