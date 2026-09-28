/**
 * An in-memory map whose entries lapse after their own TTL. Expired entries are
 * swept on every `set`, so the map stays bounded by what was set within the
 * longest TTL, with no timer to hold the process open.
 */
export const createExpiringMap = <T>() => {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const get = (key: string): T | undefined => {
    const entry = entries.get(key);
    return entry && entry.expiresAt > Date.now() ? entry.value : undefined;
  };
  return {
    set: (key: string, value: T, ttlMs: number): void => {
      const now = Date.now();
      for (const [k, entry] of entries) if (entry.expiresAt <= now) entries.delete(k);
      entries.set(key, { value, expiresAt: now + ttlMs });
    },
    get,
    /** Read and forget: a pending value is used at most once. */
    take: (key: string): T | undefined => {
      const value = get(key);
      entries.delete(key);
      return value;
    },
    /** Live and not-yet-swept entries. */
    size: (): number => entries.size,
  };
};
