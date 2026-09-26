import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CompactEncrypt, compactDecrypt, decodeProtectedHeader } from 'jose';
import Keyv, { type KeyvStoreAdapter } from 'keyv';
import type { Adapter, AdapterFactory, AdapterPayload } from 'oidc-provider';
import { createFileStore } from './file-store';
import type { KeyRing } from './keys';

/**
 * Models that must survive a restart. Everything else (sessions, interactions,
 * authorization codes, ...) stays in memory: a restart costs an in-flight login
 * at most. `ZendeskTokens` is ours, keyed by grant id.
 */
export const PERSISTENT_MODELS: ReadonlySet<string> = new Set([
  'Client',
  'Grant',
  'RefreshToken',
  'ZendeskTokens',
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Ids are hashed because oidc-provider uses an opaque token's *value* as its
// id: stored raw, a readable store file would hand out valid refresh tokens.
const hashId = (id: string): string => createHash('sha256').update(id).digest('base64url');

interface SealedRecord<T> {
  readonly value: T;
  /** False when the record was sealed under an older secret. */
  readonly current: boolean;
}

export interface SealedCollection<T> {
  get(id: string): Promise<T | undefined>;
  set(id: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(id: string): Promise<void>;
}

const seal = (ring: KeyRing, value: unknown): Promise<string> =>
  new CompactEncrypt(encoder.encode(JSON.stringify(value)))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', kid: ring[0].atRest.kid })
    .encrypt(ring[0].atRest.key);

const open = async <T>(ring: KeyRing, sealed: string): Promise<SealedRecord<T> | undefined> => {
  try {
    const { kid } = decodeProtectedHeader(sealed);
    const keySet = ring.find((set) => set.atRest.kid === kid);
    if (!keySet) return undefined;
    const { plaintext } = await compactDecrypt(sealed, keySet.atRest.key);
    return { value: JSON.parse(decoder.decode(plaintext)) as T, current: keySet === ring[0] };
  } catch {
    // Unknown kid, tampering or a foreign value: indistinguishable from absent.
    return undefined;
  }
};

const remainingTtlMs = (value: unknown): number | undefined => {
  const exp = (value as { exp?: unknown } | undefined)?.exp;
  return typeof exp === 'number' ? Math.max(exp * 1000 - Date.now(), 1) : undefined;
};

/**
 * One named collection of whole-payload-encrypted records. A record read under
 * an older secret is rewritten under the current one, so dropping that secret
 * later loses nothing still in use (DCR clients are otherwise never rewritten).
 */
export const createSealedCollection = <T>(
  store: Keyv,
  name: string,
  ring: KeyRing,
): SealedCollection<T> => {
  const key = (id: string) => `${name}:${hashId(id)}`;
  return {
    get: async (id) => {
      const sealed = await store.get<string>(key(id));
      if (typeof sealed !== 'string') return undefined;
      const record = await open<T>(ring, sealed);
      if (record && !record.current) {
        await store.set(key(id), await seal(ring, record.value), remainingTtlMs(record.value));
      }
      return record?.value;
    },
    set: async (id, value, ttlSeconds) => {
      await store.set(key(id), await seal(ring, value), ttlSeconds ? ttlSeconds * 1000 : undefined);
    },
    delete: async (id) => {
      await store.delete(key(id));
    },
  };
};

// Keyv has no atomic read-modify-write; the grant index is the only such
// update, so it is serialised per key in-process (single instance, ADR).
const createKeyLock = () => {
  const tails = new Map<string, Promise<unknown>>();
  return <R>(lockKey: string, fn: () => Promise<R>): Promise<R> => {
    const run = (tails.get(lockKey) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    tails.set(lockKey, tail);
    void tail.then(() => {
      if (tails.get(lockKey) === tail) tails.delete(lockKey);
    });
    return run;
  };
};

interface GrantIndex {
  readonly ids: readonly string[];
  readonly exp?: number | undefined;
}

export interface AdapterStores {
  /** The configured backend (`--oauth-store`). */
  readonly persistent: Keyv;
  /** Short-lived models; defaults to a fresh in-memory Keyv. */
  readonly memory?: Keyv | undefined;
}

/** oidc-provider adapter factory over two Keyv stores, sealed with the at-rest key. */
export const createAdapterFactory = (stores: AdapterStores, ring: KeyRing): AdapterFactory => {
  const memory = stores.memory ?? new Keyv();
  const withLock = createKeyLock();

  return (name: string): Adapter => {
    const store = PERSISTENT_MODELS.has(name) ? stores.persistent : memory;
    const records = createSealedCollection<AdapterPayload>(store, name, ring);
    const grantIndex = createSealedCollection<GrantIndex>(store, `${name}:grant`, ring);
    const uidIndex = createSealedCollection<string>(store, `${name}:uid`, ring);

    const indexGrant = (grantId: string, id: string, exp: number | undefined) =>
      withLock(`${name}:${grantId}`, async () => {
        const current = await grantIndex.get(grantId);
        const latestExp = Math.max(current?.exp ?? 0, exp ?? 0) || undefined;
        const ttl = latestExp ? Math.max(latestExp - Math.floor(Date.now() / 1000), 1) : undefined;
        await grantIndex.set(grantId, { ids: [...(current?.ids ?? []), id], exp: latestExp }, ttl);
      });

    return {
      upsert: async (id, payload, expiresIn) => {
        await records.set(id, payload, expiresIn);
        if (payload.grantId) await indexGrant(payload.grantId, id, payload.exp);
        if (payload.uid) await uidIndex.set(payload.uid, id, expiresIn);
      },
      find: (id) => records.get(id),
      findByUid: async (uid) => {
        const id = await uidIndex.get(uid);
        return id ? records.get(id) : undefined;
      },
      // Device flow is not enabled.
      findByUserCode: async () => undefined,
      consume: async (id) => {
        const payload = await records.get(id);
        if (!payload) return;
        const ttl = remainingTtlMs(payload);
        await records.set(
          id,
          { ...payload, consumed: Math.floor(Date.now() / 1000) },
          ttl ? Math.ceil(ttl / 1000) : undefined,
        );
      },
      destroy: (id) => records.delete(id),
      revokeByGrantId: (grantId) =>
        withLock(`${name}:${grantId}`, async () => {
          const index = await grantIndex.get(grantId);
          await Promise.all((index?.ids ?? []).map((id) => records.delete(id)));
          await grantIndex.delete(grantId);
        }),
    };
  };
};

type KeyvStoreModule = Record<string, unknown> & { default?: unknown };

// Kept a variable specifier so the bundler leaves these optional packages to
// runtime resolution: only the scheme a deployer picks has to be installed.
const importOptional = async (specifier: string): Promise<KeyvStoreModule> => {
  try {
    return (await import(specifier)) as KeyvStoreModule;
  } catch (err) {
    throw new Error(
      `The OAuth store needs the package "${specifier}". Install it next to the server (npm install ${specifier}).`,
      { cause: err },
    );
  }
};

const constructStore = (module: KeyvStoreModule, uri: string): KeyvStoreAdapter => {
  // Every @keyv/* store default-exports a class taking the connection URI.
  const Store = module.default;
  if (typeof Store !== 'function') {
    throw new Error('The OAuth store adapter package has no default-exported Keyv store class.');
  }
  return new (Store as new (uri: string) => KeyvStoreAdapter)(uri);
};

const SCHEME_PACKAGES: Readonly<Record<string, string>> = {
  'redis:': '@keyv/redis',
  'rediss:': '@keyv/redis',
  'postgres:': '@keyv/postgres',
  'postgresql:': '@keyv/postgres',
  'sqlite:': '@keyv/sqlite',
};

/**
 * Open the persistent store named by `--oauth-store`. `file://` and `memory://`
 * are built in; the other schemes import their `@keyv/*` package on demand, and
 * `--oauth-store-adapter` loads any third-party Keyv store for the URI.
 */
export const openStore = async (uri: string, adapterPackage?: string): Promise<Keyv> => {
  if (adapterPackage)
    return new Keyv({ store: constructStore(await importOptional(adapterPackage), uri) });
  const { protocol } = new URL(uri);
  if (protocol === 'memory:') return new Keyv();
  if (protocol === 'file:') return new Keyv({ store: createFileStore(fileURLToPath(uri)) });
  const specifier = SCHEME_PACKAGES[protocol];
  if (!specifier) {
    throw new Error(
      `Unsupported OAuth store scheme "${protocol}". Use file://, memory://, redis://, postgres://, sqlite://, or --oauth-store-adapter.`,
    );
  }
  return new Keyv({ store: constructStore(await importOptional(specifier), uri) });
};
