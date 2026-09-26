import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExpiringMap } from '../../../../src/auth/server/expiring-map';

describe('createExpiringMap', () => {
  let now = 1_000_000;
  const at = (ms: number) => {
    now = ms;
  };
  beforeEach(() => {
    at(1_000_000);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns a value until its TTL has fully elapsed, and never after', () => {
    const map = createExpiringMap<string>();
    map.set('a', 'value', 100);
    at(1_000_099);
    expect(map.get('a')).toBe('value');
    at(1_000_100);
    expect(map.get('a')).toBeUndefined();
    expect(map.get('missing')).toBeUndefined();
  });

  it('keeps a read value but forgets a taken one', () => {
    const map = createExpiringMap<string>();
    map.set('a', 'value', 100);
    expect(map.get('a')).toBe('value');
    expect(map.get('a')).toBe('value');
    expect(map.take('a')).toBe('value');
    expect(map.take('a')).toBeUndefined();
    expect(map.take('missing')).toBeUndefined();
    expect(map.size()).toBe(0);
  });

  it('gives each entry its own TTL', () => {
    const map = createExpiringMap<string>();
    map.set('short', 's', 10);
    map.set('long', 'l', 1000);
    at(1_000_500);
    expect(map.get('short')).toBeUndefined();
    expect(map.get('long')).toBe('l');
  });

  it('sweeps expired entries on set, and only those', () => {
    const map = createExpiringMap<string>();
    map.set('expired', 'x', 100);
    map.set('live', 'y', 1000);
    at(1_000_100);
    map.set('new', 'z', 100);
    expect(map.size()).toBe(2);
    expect(map.get('live')).toBe('y');
    expect(map.take('new')).toBe('z');
  });
});
