import { describe, expect, it, vi } from 'vitest';
import { createScopeCache } from '../../../src/utils/scope-cache';
import { createMemoryStore, type StateStore } from '../../../src/utils/state-store';

describe('createScopeCache', () => {
  it('serves a second call from the store within the lifetime', async () => {
    let clock = 0;
    const cache = createScopeCache(
      createMemoryStore(() => clock),
      60_000,
    );
    const load = vi.fn(() => Promise.resolve({ tickets: [1] }));
    expect(await cache('k', load)).toEqual({ tickets: [1] });
    clock = 59_999;
    expect(await cache('k', load)).toEqual({ tickets: [1] });
    expect(load).toHaveBeenCalledTimes(1);
    clock = 60_000;
    await cache('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight load between concurrent identical calls', async () => {
    const cache = createScopeCache(createMemoryStore(), 60_000);
    let release: (v: string) => void = () => undefined;
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const a = cache('k', load);
    const b = cache('k', load);
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    release('v');
    expect(await Promise.all([a, b])).toEqual(['v', 'v']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps keys apart', async () => {
    const cache = createScopeCache(createMemoryStore(), 60_000);
    expect(await cache('a', () => Promise.resolve(1))).toBe(1);
    expect(await cache('b', () => Promise.resolve(2))).toBe(2);
  });

  it('caches nothing with a zero lifetime', async () => {
    const store = createMemoryStore();
    const cache = createScopeCache(store, 0);
    const load = vi.fn(() => Promise.resolve(1));
    await cache('k', load);
    await cache('k', load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await store.get('k')).toBeUndefined();
  });

  it('lets a failed load reject every waiter, and retries on the next call', async () => {
    const cache = createScopeCache(createMemoryStore(), 60_000);
    const load = vi.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce('ok');
    await expect(cache('k', load)).rejects.toThrow('429');
    expect(await cache('k', load)).toBe('ok');
  });

  it('still answers when the store cannot read or write', async () => {
    const broken: StateStore = {
      get: () => Promise.reject(new Error('EIO')),
      set: () => Promise.reject(new Error('ENOSPC')),
      delete: () => Promise.resolve(),
      sweep: () => Promise.resolve(true),
    };
    const cache = createScopeCache(broken, 60_000);
    expect(await cache('k', () => Promise.resolve('fresh'))).toBe('fresh');
  });
});
