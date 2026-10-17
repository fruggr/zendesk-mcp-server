import { describe, expect, it, vi } from 'vitest';
import { createGrantRegistry } from '../../../src/utils/grant-registry';

const entry = () => ({ close: vi.fn().mockResolvedValue(undefined) });

const clock = (start = 1_000) => {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number): void => {
      now += ms;
    },
  };
};

describe('createGrantRegistry', () => {
  it('creates an entry on first use and returns the same one afterwards', () => {
    const registry = createGrantRegistry<ReturnType<typeof entry>>({ idleTimeoutMs: 100 });
    const create = vi.fn(entry);

    const first = registry.acquire('g1', 'user-a', create);
    const second = registry.acquire('g1', 'user-a', create);

    expect(first).toBe(second);
    expect(create).toHaveBeenCalledOnce();
    expect(registry.size).toBe(1);
  });

  it('keeps one entry per grant, even for the same user', () => {
    const registry = createGrantRegistry<ReturnType<typeof entry>>({ idleTimeoutMs: 100 });

    const a = registry.acquire('g1', 'user-a', entry);
    const b = registry.acquire('g2', 'user-a', entry);

    expect(a).not.toBe(b);
    expect(registry.size).toBe(2);
  });

  it('refuses a grant presented for another subject', () => {
    const registry = createGrantRegistry<ReturnType<typeof entry>>({ idleTimeoutMs: 100 });
    registry.acquire('g1', 'user-a', entry);
    const create = vi.fn(entry);

    expect(registry.acquire('g1', 'user-b', create)).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it('evicts and closes an entry idle past the timeout', async () => {
    const time = clock();
    const registry = createGrantRegistry<ReturnType<typeof entry>>({
      idleTimeoutMs: 100,
      now: time.now,
    });
    const idle = registry.acquire('g1', 'user-a', entry);
    time.advance(100);

    await registry.sweep();

    expect(idle?.close).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });

  it('keeps an entry used within the timeout', async () => {
    const time = clock();
    const registry = createGrantRegistry<ReturnType<typeof entry>>({
      idleTimeoutMs: 100,
      now: time.now,
    });
    const busy = registry.acquire('g1', 'user-a', entry);
    time.advance(60);
    registry.acquire('g1', 'user-a', entry);
    time.advance(60);

    await registry.sweep();

    expect(busy?.close).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
  });

  it('closes a grant at once, and creates a fresh entry on its next use', async () => {
    const registry = createGrantRegistry<ReturnType<typeof entry>>({ idleTimeoutMs: 100 });
    const first = registry.acquire('g1', 'user-a', entry);

    await registry.close('g1');
    const next = registry.acquire('g1', 'user-a', entry);

    expect(first?.close).toHaveBeenCalledOnce();
    expect(next).not.toBe(first);
  });

  it('ignores closing a grant it does not hold', async () => {
    const onCloseError = vi.fn();
    const registry = createGrantRegistry<ReturnType<typeof entry>>({
      idleTimeoutMs: 100,
      onCloseError,
    });

    await registry.close('missing');

    expect(onCloseError).not.toHaveBeenCalled();
  });

  it('closes every entry on closeAll', async () => {
    const registry = createGrantRegistry<ReturnType<typeof entry>>({ idleTimeoutMs: 100 });
    const a = registry.acquire('g1', 'user-a', entry);
    const b = registry.acquire('g2', 'user-b', entry);

    await registry.closeAll();

    expect(a?.close).toHaveBeenCalledOnce();
    expect(b?.close).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });

  it('reports a failed close and keeps sweeping', async () => {
    const time = clock();
    const onCloseError = vi.fn();
    const registry = createGrantRegistry<ReturnType<typeof entry>>({
      idleTimeoutMs: 100,
      now: time.now,
      onCloseError,
    });
    const broken = registry.acquire('g1', 'user-a', () => ({
      close: vi.fn().mockRejectedValue(new Error('stuck')),
    }));
    const other = registry.acquire('g2', 'user-b', entry);
    time.advance(100);

    await registry.sweep();

    expect(broken?.close).toHaveBeenCalledOnce();
    expect(onCloseError).toHaveBeenCalledWith('g1', new Error('stuck'));
    expect(other?.close).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });
});
