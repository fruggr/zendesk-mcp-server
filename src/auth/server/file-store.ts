import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The key-value contract the authorization server stores its sealed records in.
 * Values are opaque strings (JWEs); `ttlMs` makes a record expire. A new backend
 * (Redis, a database) implements this and nothing else: the store is not
 * pluggable today, deliberately (ADR, Storage).
 */
export interface RecordStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** One record: its value and, when it expires, the epoch ms it does. */
export interface StoredEntry {
  readonly v: string;
  readonly exp?: number;
}

const isWindows = process.platform === 'win32';

const isLive = (entry: StoredEntry, now: number): boolean =>
  entry.exp === undefined || entry.exp > now;

/**
 * A store over a `Map`, calling `onChange` after every write. The map is the
 * caller's, so a test can look at exactly what was stored.
 */
export const createMemoryStore = (
  entries: Map<string, StoredEntry> = new Map(),
  onChange: () => void = () => undefined,
): RecordStore => ({
  get: async (key) => {
    const entry = entries.get(key);
    return entry && isLive(entry, Date.now()) ? entry.v : undefined;
  },
  set: async (key, value, ttlMs) => {
    entries.set(key, ttlMs === undefined ? { v: value } : { v: value, exp: Date.now() + ttlMs });
    onChange();
  },
  delete: async (key) => {
    if (entries.delete(key)) onChange();
  },
});

const isEntry = (value: unknown): value is StoredEntry =>
  typeof (value as StoredEntry | null)?.v === 'string' &&
  ((value as StoredEntry).exp === undefined || typeof (value as StoredEntry).exp === 'number');

const load = (path: string): Map<string, StoredEntry> => {
  let raw: string;
  try {
    // Stryker disable next-line StringLiteral: JSON.parse decodes a Buffer as UTF-8 all the same.
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
      (entry): entry is [string, StoredEntry] => isEntry(entry[1]) && isLive(entry[1], now),
    ),
  );
};

// tmp + rename so a crash mid-write leaves the previous file intact; owner-only
// perms because the file holds (encrypted) refresh tokens. Expired records are
// dropped on the way out, so the file does not grow with dead entries.
const persist = (path: string, entries: Map<string, StoredEntry>): void => {
  const now = Date.now();
  const live = [...entries].filter(([, entry]) => isLive(entry, now));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(live)), { mode: 0o600 });
  if (!isWindows) chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};

/**
 * The default store: one JSON file, written atomically on every change. Chosen
 * over `keyv-file`, whose plain `writeFile` can truncate the file on a crash and
 * whose loader then silently starts empty. Single process only (ADR, Storage).
 */
export const createFileStore = (path: string): RecordStore => {
  const entries = load(path);
  return createMemoryStore(entries, () => persist(path, entries));
};
