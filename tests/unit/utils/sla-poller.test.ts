import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAlertPoller } from '../../../src/utils/sla-poller';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// A poller whose fingerprints come from `state`, recording notifications.
const setup = (intervalMs = 1000) => {
  const state = new Map<string, string>();
  const notified: string[] = [];
  const errors: string[] = [];
  const check = vi.fn((uri: string) => {
    const fp = state.get(uri);
    return fp === undefined
      ? Promise.reject(new Error(`no state for ${uri}`))
      : Promise.resolve(fp);
  });
  const poller = createAlertPoller({
    intervalMs,
    check,
    notify: (uri) => {
      notified.push(uri);
      return Promise.resolve();
    },
    onError: (uri, error) => errors.push(`${uri}: ${(error as Error).message}`),
  });
  return { state, notified, errors, check, poller };
};

describe('createAlertPoller', () => {
  it('takes a baseline on subscribe and notifies only when the fingerprint changes', async () => {
    const { state, notified, poller } = setup();
    state.set('a', 'one');
    poller.subscribe('a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(notified).toEqual([]);
    state.set('a', 'two');
    await vi.advanceTimersByTimeAsync(1000);
    expect(notified).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(notified).toEqual(['a']);
  });

  it('polls on the interval, not sooner', async () => {
    const { state, check, poller } = setup(5000);
    state.set('a', 'one');
    poller.subscribe('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('subscribes a URI once', async () => {
    const { state, check, poller } = setup();
    state.set('a', 'one');
    poller.subscribe('a');
    poller.subscribe('a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(poller.subscriptions()).toEqual(['a']);
  });

  it('stops polling with the last unsubscription, and resumes on a new one', async () => {
    const { state, check, poller } = setup();
    state.set('a', 'one');
    state.set('b', 'one');
    poller.subscribe('a');
    poller.subscribe('b');
    poller.unsubscribe('a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(check.mock.calls.map(([uri]) => uri)).toEqual(['a', 'b', 'b']);
    poller.unsubscribe('b');
    await vi.advanceTimersByTimeAsync(5000);
    expect(check).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    poller.subscribe('a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(check).toHaveBeenCalledTimes(5);
  });

  it('stops everything on stop', async () => {
    const { state, check, poller } = setup();
    state.set('a', 'one');
    poller.subscribe('a');
    poller.stop();
    expect(poller.subscriptions()).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a failed check and keeps polling, taking the next success as baseline', async () => {
    const { state, notified, errors, poller } = setup();
    poller.subscribe('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual(['a: no state for a']);
    state.set('a', 'one');
    await vi.advanceTimersByTimeAsync(1000);
    expect(notified).toEqual([]);
    state.set('a', 'two');
    await vi.advanceTimersByTimeAsync(1000);
    expect(notified).toEqual(['a']);
  });

  it('reports a failed notification', async () => {
    const poller = createAlertPoller({
      intervalMs: 1000,
      check: vi.fn().mockResolvedValueOnce('one').mockResolvedValue('two'),
      notify: () => Promise.reject(new Error('closed')),
      onError: (uri, error) => errors.push(`${uri}: ${(error as Error).message}`),
    });
    const errors: string[] = [];
    poller.subscribe('a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toEqual(['a: closed']);
  });

  it('notifies again on the next round when a notification failed', async () => {
    const errors: string[] = [];
    const notified: string[] = [];
    const notify = vi
      .fn<(uri: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('closed'))
      .mockImplementation((uri) => {
        notified.push(uri);
        return Promise.resolve();
      });
    const poller = createAlertPoller({
      intervalMs: 1000,
      check: vi.fn().mockResolvedValueOnce('one').mockResolvedValue('two'),
      notify,
      onError: (uri, error) => errors.push(`${uri}: ${(error as Error).message}`),
    });
    poller.subscribe('a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toEqual(['a: closed']);
    expect(notified).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(notified).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(notified).toEqual(['a']);
  });

  it('forgets a URI unsubscribed while its notification was on the way', async () => {
    let release: () => void = () => undefined;
    const poller = createAlertPoller({
      intervalMs: 1000,
      check: vi.fn().mockResolvedValueOnce('one').mockResolvedValue('two'),
      notify: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    poller.subscribe('a');
    await vi.advanceTimersByTimeAsync(1000);
    poller.unsubscribe('a');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.subscriptions()).toEqual([]);
  });

  it('drops the result of a check that finishes after the unsubscription', async () => {
    let release: (fp: string) => void = () => undefined;
    const notify = vi.fn(() => Promise.resolve());
    const poller = createAlertPoller({
      intervalMs: 1000,
      check: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
      notify,
    });
    poller.subscribe('a');
    poller.unsubscribe('a');
    release('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.subscriptions()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('never overlaps two rounds', async () => {
    let pending = 0;
    let peak = 0;
    const poller = createAlertPoller({
      intervalMs: 1000,
      check: async () => {
        pending += 1;
        peak = Math.max(peak, pending);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        pending -= 1;
        return 'same';
      },
      notify: () => Promise.resolve(),
    });
    poller.subscribe('a');
    await vi.advanceTimersByTimeAsync(2600);
    await poller.tick();
    expect(peak).toBeLessThanOrEqual(2);
    poller.stop();
  });

  it('ignores errors by default and keeps polling', async () => {
    const check = vi.fn(() => Promise.reject(new Error('x')));
    const poller = createAlertPoller({
      intervalMs: 1000,
      check,
      notify: () => Promise.resolve(),
    });
    poller.subscribe('a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(check).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('never keeps the process alive', () => {
    const unref = vi.fn();
    const spy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);
    const { state, poller } = setup();
    state.set('a', 'one');
    poller.subscribe('a');
    expect(unref).toHaveBeenCalled();
    spy.mockRestore();
  });
});
