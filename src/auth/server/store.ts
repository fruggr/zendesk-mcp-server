import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CompactEncrypt, compactDecrypt, decodeProtectedHeader } from 'jose';
import type { Adapter, AdapterFactory, AdapterPayload } from 'oidc-provider';
import { createFileStore, createMemoryStore, type RecordStore } from './file-store';
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

const unseal = async <T>(ring: KeyRing, sealed: string): Promise<SealedRecord<T> | undefined> => {
  const { kid } = decodeProtectedHeader(sealed);
  const keySet = ring.find((set) => set.atRest.kid === kid);
  // Stryker disable next-line ConditionalExpression: without the guard the missing key throws
  // into open's catch, which answers undefined all the same.
  if (!keySet) return undefined;
  const { plaintext } = await compactDecrypt(sealed, keySet.atRest.key);
  return { value: JSON.parse(decoder.decode(plaintext)) as T, current: keySet === ring[0] };
};

// Unknown kid, tampering or a foreign value: indistinguishable from absent.
const open = <T>(ring: KeyRing, sealed: string): Promise<SealedRecord<T> | undefined> =>
  unseal<T>(ring, sealed).catch(() => undefined);

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
  store: RecordStore,
  name: string,
  ring: KeyRing,
): SealedCollection<T> => {
  const key = (id: string) => `${name}:${hashId(id)}`;
  return {
    get: async (id) => {
      const sealed = await store.get(key(id));
      // Stryker disable next-line ConditionalExpression: open answers undefined for a missing one too.
      if (sealed === undefined) return undefined;
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

// The store has no atomic read-modify-write, so such updates (the grant index, the
// Zendesk refresh) are serialised per key in-process (single instance, ADR).
export const createKeyLock = () => {
  const tails = new Map<string, Promise<unknown>>();
  return <R>(lockKey: string, fn: () => Promise<R>): Promise<R> => {
    const run = (tails.get(lockKey) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    tails.set(lockKey, tail);
    // Stryker disable next-line BlockStatement: the cleanup only bounds memory; a settled tail
    // left in the map chains the next call exactly like an empty slot.
    void tail.then(() => {
      // Stryker disable next-line ConditionalExpression,CallExpression: as above, memory only.
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
  readonly persistent: RecordStore;
  /** Short-lived models; defaults to a fresh in-memory store. */
  readonly memory?: RecordStore | undefined;
}

/** oidc-provider adapter factory over two stores, sealed with the at-rest key. */
export const createAdapterFactory = (stores: AdapterStores, ring: KeyRing): AdapterFactory => {
  const memory = stores.memory ?? createMemoryStore();
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
          if (!index) return;
          await Promise.all(index.ids.map((id) => records.delete(id)));
          await grantIndex.delete(grantId);
        }),
    };
  };
};

/**
 * Open the persistent store named by `--oauth-store`: `file://` (the default)
 * or `memory://` (tests, throwaway runs). Another backend means implementing
 * `RecordStore`; the ADR records why the store is not pluggable yet.
 */
export const openStore = (uri: string): RecordStore => {
  const { protocol } = new URL(uri);
  if (protocol === 'memory:') return createMemoryStore();
  if (protocol === 'file:') return createFileStore(fileURLToPath(uri));
  throw new Error(`Unsupported OAuth store scheme "${protocol}". Use file:// or memory://.`);
};
