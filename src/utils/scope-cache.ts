import type { StateStore } from './state-store';

export type ScopeCache = <T>(key: string, load: () => Promise<T>) => Promise<T>;

/**
 * Serves `load()` from `store` for `ttlMs`, and makes concurrent calls for the
 * same key share one in-flight load. Zendesk charges a conditional GET as a
 * full request (PR #387 spike 2), so this lifetime is the only quota saving.
 * A store that fails to save only costs the cache, never the answer.
 */
export const createScopeCache = (store: StateStore, ttlMs: number): ScopeCache => {
  const inFlight = new Map<string, Promise<unknown>>();
  return <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const pending = inFlight.get(key);
    if (pending) return pending as Promise<T>;
    const run = (async () => {
      const hit = await store.get(key).catch(() => undefined);
      if (hit !== undefined) return hit as T;
      const value = await load();
      // A zero lifetime stores an entry already expired, so nothing is reused.
      await store.set(key, value, ttlMs).catch(() => undefined);
      return value;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, run);
    return run;
  };
};
