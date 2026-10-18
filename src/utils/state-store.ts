import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Small key/value state this server keeps per Zendesk user: SLA scope fetches
 * (short-lived cache) and alert preferences (no expiry). Values must survive a
 * JSON round trip, because the disk store is shared by every stdio process of
 * the machine.
 */
export interface StateStore {
  /**
   * `undefined` for a missing or expired key. Rejects only when the store
   * cannot be read: a caller told "missing" would overwrite what it holds.
   */
  get(key: string): Promise<unknown>;
  /** `ttlMs` omitted: the entry never expires. */
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Drops expired entries; resolves `false` when another process holds the sweep. */
  sweep(): Promise<boolean>;
}

interface Entry {
  key: string;
  value: unknown;
  expiresAt?: number;
}

const isLive = (entry: Entry, now: number): boolean =>
  entry.expiresAt === undefined || entry.expiresAt > now;

const toEntry = (key: string, value: unknown, now: number, ttlMs?: number): Entry =>
  ttlMs === undefined ? { key, value } : { key, value, expiresAt: now + ttlMs };

/** One process, nothing on disk: the default on HTTP, where sessions share the process. */
export const createMemoryStore = (now: () => number = Date.now): StateStore => {
  const entries = new Map<string, Entry>();
  return {
    get: async (key) => {
      const entry = entries.get(key);
      return entry && isLive(entry, now()) ? entry.value : undefined;
    },
    set: async (key, value, ttlMs) => {
      entries.set(key, toEntry(key, value, now(), ttlMs));
    },
    delete: async (key) => {
      entries.delete(key);
    },
    sweep: async () => {
      const at = now();
      for (const [key, entry] of entries) if (!isLive(entry, at)) entries.delete(key);
      return true;
    },
  };
};

export interface DiskStoreOptions {
  now?: () => number;
  /** A cleanup lock older than this is abandoned and taken over. */
  lockStaleMs?: number;
  /** A temp file older than this is a write that died before its rename. */
  tempStaleMs?: number;
}

const LOCK_FILE = 'cleanup.lock';

const errnoOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

// A file already gone is what removing it wanted: another process swept it.
const ignore = (): undefined => undefined;
const remove = (path: string): Promise<void> => unlink(path).catch(ignore);

// Hashed, so a key's characters never reach the filesystem; the entry repeats
// its key, so a read can tell its own entry from a hash collision.
const fileOf = (dir: string, key: string): string =>
  join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);

// ENOENT is a miss (a sweep may have just deleted it), and so is a file that is
// not an entry; any other failure rejects.
const readEntry = (path: string): Promise<Entry | undefined> =>
  // Stryker disable next-line StringLiteral: without an encoding JSON.parse reads the Buffer as UTF-8 text anyway.
  readFile(path, 'utf8')
    .then((text) => JSON.parse(text) as Entry)
    .catch((err: unknown) => {
      if (err instanceof SyntaxError || errnoOf(err) === 'ENOENT') return undefined;
      throw err;
    });

/**
 * Entries as one file each under `dir` (0600, directory 0700), written to a
 * temp file then renamed so a reader never sees half an entry. Several stdio
 * processes we do not control share it; see `sweep` for how they clean up
 * without stepping on each other.
 */
export const createDiskStore = (dir: string, options: DiskStoreOptions = {}): StateStore => {
  const { now = Date.now, lockStaleMs = 2 * 60_000, tempStaleMs = 5 * 60_000 } = options;

  // `mkdir` alone does not fix the mode of a directory that already exists.
  // On Windows `chmod` only toggles the read-only bit, which 0o700 leaves off.
  const ensureDir = async (): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  };

  // O_EXCL creation is the election: only the process that creates the lock
  // sweeps. A lock left by a crashed sweeper is taken over once stale; two
  // processes taking over at once can both sweep, which is harmless. Resolves
  // true when acquired, false when another process holds it, null when the
  // directory does not exist.
  const acquireLock = async (lock: string, mayTakeOver = true): Promise<boolean | null> => {
    try {
      const handle = await open(lock, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: now() }));
      await handle.close();
      return true;
    } catch (err) {
      const code = errnoOf(err);
      if (code === 'ENOENT') return null;
      // Stryker disable next-line ConditionalExpression,LogicalOperator: any other error fails the bounded retry below the same way.
      if (code !== 'EEXIST' || !mayTakeOver) return false;
    }
    const held = (await readEntry(lock).catch(ignore)) as { at?: number } | undefined;
    if (typeof held?.at === 'number' && now() - held.at < lockStaleMs) return false;
    await remove(lock);
    return acquireLock(lock, false);
  };

  // A file that is not an entry, or cannot be read, is left alone.
  const sweepFile = async (name: string, at: number): Promise<void> => {
    const path = join(dir, name);
    if (name.endsWith('.tmp')) {
      const info = await stat(path).catch(ignore);
      if (info && at - info.mtimeMs > tempStaleMs) await remove(path);
      return;
    }
    const entry = await readEntry(path).catch(ignore);
    if (entry && !isLive(entry, at)) await remove(path);
  };

  return {
    get: async (key) => {
      const entry = await readEntry(fileOf(dir, key));
      return entry?.key === key && isLive(entry, now()) ? entry.value : undefined;
    },
    set: async (key, value, ttlMs) => {
      await ensureDir();
      const path = fileOf(dir, key);
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(toEntry(key, value, now(), ttlMs)), { mode: 0o600 });
      await rename(temp, path);
    },
    delete: (key) => remove(fileOf(dir, key)),
    // A store never written to has no directory: nothing to sweep.
    sweep: async () => {
      const lock = join(dir, LOCK_FILE);
      const acquired = await acquireLock(lock);
      if (acquired !== true) return acquired === null;
      try {
        const at = now();
        // The lock itself reads as an entry with no expiry, so it is kept.
        for (const name of await readdir(dir)) await sweepFile(name, at);
      } finally {
        await remove(lock);
      }
      return true;
    },
  };
};

/**
 * Sweeps `store` every `intervalMs`, never at startup. The timer is unref'd so
 * it never keeps a process alive; the returned function stops it.
 */
export const startSweeper = (store: StateStore, intervalMs = 10 * 60_000): (() => void) => {
  const timer = setInterval(() => {
    store.sweep().catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};
