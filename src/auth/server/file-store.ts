import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { KeyvStoreAdapter, StoredData } from 'keyv';

const isWindows = process.platform === 'win32';

// Keyv serializes each entry as `{"value":...,"expires":<epoch ms>}`; reading
// `expires` back lets a restart drop entries nobody will ever read again.
const isExpired = (serialized: string, now: number): boolean => {
  try {
    const { expires } = JSON.parse(serialized) as { expires?: unknown };
    return typeof expires === 'number' && expires <= now;
  } catch {
    return false;
  }
};

const load = (path: string): Map<string, string> => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new Error(`Cannot read the OAuth store file (${(err as NodeJS.ErrnoException).code}).`, {
      cause: err,
    });
  }
  // A corrupt file is an operator problem, not an empty store: silently starting
  // empty would log every user out with no trace of why.
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The OAuth store file is not a JSON object.');
  }
  const now = Date.now();
  return new Map(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !isExpired(entry[1], now),
    ),
  );
};

// tmp + rename so a crash mid-write leaves the previous file intact; owner-only
// perms because the file holds (encrypted) refresh tokens.
const persist = (path: string, data: Map<string, string>): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(data)), { encoding: 'utf8', mode: 0o600 });
  if (!isWindows) chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};

/**
 * A Keyv store backed by one JSON file, written atomically on every change.
 * Replaces `keyv-file`, whose plain `writeFile` can truncate the file on a
 * crash and whose loader then silently starts empty. Single process only,
 * like the rest of the store (ADR, Storage).
 */
export const createFileStore = (path: string): KeyvStoreAdapter => {
  const data = load(path);
  const events = new EventEmitter();
  const store: KeyvStoreAdapter = {
    opts: { path },
    get: async <Value>(key: string) => data.get(key) as StoredData<Value> | undefined,
    set: async (key: string, value: string) => {
      data.set(key, value);
      persist(path, data);
    },
    delete: async (key: string) => {
      const existed = data.delete(key);
      if (existed) persist(path, data);
      return existed;
    },
    clear: async () => {
      data.clear();
      persist(path, data);
    },
    on: (event, listener) => {
      events.on(event, listener);
      return store;
    },
  };
  return store;
};
