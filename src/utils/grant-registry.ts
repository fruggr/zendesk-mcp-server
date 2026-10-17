/**
 * What the HTTP transport keeps per OAuth grant for 2026-07-28 traffic, where
 * every request gets a fresh server: whatever must outlive one request (the
 * caches, the listen bus). Keyed by grant, not user: a grant carries one Zendesk
 * token, so an entry always fetches with the token of the grant using it, and a
 * revoked grant closes its own entry only.
 */
export interface GrantRegistry<E extends { close(): Promise<void> }> {
  /**
   * The grant's entry, created with `create` on first use; refreshes its idle
   * clock. `undefined` when the grant is presented for another subject.
   */
  acquire(grantId: string, subject: string, create: () => E): E | undefined;
  /**
   * Close and drop the grant's entry now (revocation). Given `entry`, only when
   * that one is still the grant's: a newer entry for the same grant is left open.
   */
  close(grantId: string, entry?: E): Promise<void>;
  /** Close and drop every entry idle for at least the timeout. */
  sweep(): Promise<void>;
  closeAll(): Promise<void>;
  readonly size: number;
}

export interface GrantRegistryOptions {
  /** Same rule as a 2025 session: idle this long since its last request, it goes. */
  idleTimeoutMs: number;
  now?: () => number;
  onCloseError?: (grantId: string, error: unknown) => void;
}

interface Slot<E> {
  subject: string;
  entry: E;
  lastActivityAt: number;
}

export const createGrantRegistry = <E extends { close(): Promise<void> }>({
  idleTimeoutMs,
  now = Date.now,
  onCloseError = () => undefined,
}: GrantRegistryOptions): GrantRegistry<E> => {
  const slots = new Map<string, Slot<E>>();

  const drop = async (grantId: string, slot: Slot<E>): Promise<void> => {
    slots.delete(grantId);
    try {
      await slot.entry.close();
    } catch (error) {
      onCloseError(grantId, error);
    }
  };

  return {
    acquire: (grantId, subject, create) => {
      const existing = slots.get(grantId);
      if (existing && existing.subject !== subject) return undefined;
      const slot = existing ?? { subject, entry: create(), lastActivityAt: now() };
      slot.lastActivityAt = now();
      slots.set(grantId, slot);
      return slot.entry;
    },
    close: async (grantId, entry) => {
      const slot = slots.get(grantId);
      if (slot && (entry === undefined || slot.entry === entry)) await drop(grantId, slot);
    },
    sweep: async () => {
      const cutoff = now() - idleTimeoutMs;
      for (const [grantId, slot] of [...slots]) {
        // Each drop awaits a close: by the next one, the grant may hold a new slot.
        if (slots.get(grantId) === slot && slot.lastActivityAt <= cutoff) {
          await drop(grantId, slot);
        }
      }
    },
    closeAll: async () => {
      await Promise.all([...slots].map(([grantId, slot]) => drop(grantId, slot)));
    },
    get size() {
      return slots.size;
    },
  };
};
