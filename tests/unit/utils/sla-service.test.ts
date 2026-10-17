import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configDir } from '../../../src/auth/token-persistence';
import {
  createSlaRuntime,
  createSlaService,
  createUserIdResolver,
  startSlaRuntime,
} from '../../../src/utils/sla-service';
import { DEFAULT_SLA_THRESHOLDS } from '../../../src/utils/sla-thresholds';
import { makeConfig } from '../../integration/harness';
import { mswServer } from '../../setup';

const ME = 'https://testsubdomain.zendesk.com/api/v2/users/me';

// Answers /users/me with an id derived from the bearer token, and counts calls.
const meById = (ids: Record<string, number>) => {
  const seen: string[] = [];
  mswServer.use(
    http.get(ME, ({ request }) => {
      const token = (request.headers.get('authorization') ?? '').replace('Bearer ', '');
      seen.push(token);
      const id = ids[token];
      return id === undefined
        ? new HttpResponse('nope', { status: 401 })
        : HttpResponse.json({ user: { id } });
    }),
  );
  return seen;
};

describe('createUserIdResolver', () => {
  it('reads /users/me once per token', async () => {
    const seen = meById({ a: 1 });
    const userId = createUserIdResolver('testsubdomain', () => 'a');
    expect(await userId()).toBe(1);
    expect(await userId()).toBe(1);
    expect(seen).toEqual(['a']);
  });

  it('looks the user up again when the token changes', async () => {
    const seen = meById({ a: 1, b: 2 });
    let token = 'a';
    const userId = createUserIdResolver('testsubdomain', () => token);
    expect(await userId()).toBe(1);
    token = 'b';
    expect(await userId()).toBe(2);
    expect(seen).toEqual(['a', 'b']);
  });

  it('forgets a failed lookup so the next call retries', async () => {
    const ids: Record<string, number> = {};
    const seen = meById(ids);
    const userId = createUserIdResolver('testsubdomain', () => 'a');
    await expect(userId()).rejects.toThrow('Authentication failed');
    ids['a'] = 7;
    expect(await userId()).toBe(7);
    expect(seen).toEqual(['a', 'a']);
  });

  it('remembers at most eight tokens, dropping the oldest', async () => {
    const ids = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`t${i}`, i]));
    const seen = meById(ids);
    let token = 't0';
    const userId = createUserIdResolver('testsubdomain', () => token);
    for (let i = 0; i < 9; i += 1) {
      token = `t${i}`;
      await userId();
    }
    token = 't1';
    await userId();
    token = 't0';
    await userId();
    expect(seen).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't0']);
  });
});

describe('createSlaService', () => {
  const settings = {
    slaPush: true,
    slaThresholds: DEFAULT_SLA_THRESHOLDS,
    slaCacheTtlSeconds: 60,
    slaUserPreferences: true,
  };

  it('exposes the push switch and the admin thresholds', async () => {
    const service = createSlaService(
      { ...settings, slaPush: false },
      createSlaRuntime(settings),
      () => Promise.resolve(1),
    );
    expect(service.push).toBe(false);
    expect(await service.thresholds()).toEqual(DEFAULT_SLA_THRESHOLDS);
    expect(await service.userId()).toBe(1);
  });

  it('caches a scope per user: one user never reads another user’s entry', async () => {
    const runtime = createSlaRuntime(settings);
    const alice = createSlaService(settings, runtime, () => Promise.resolve(1));
    const bob = createSlaService(settings, runtime, () => Promise.resolve(2));
    expect(await alice.cached('scope:mine', () => Promise.resolve('alice'))).toBe('alice');
    expect(await bob.cached('scope:mine', () => Promise.resolve('bob'))).toBe('bob');
    expect(await alice.cached('scope:mine', () => Promise.resolve('stale?'))).toBe('alice');
    expect(await runtime.store.get('cache:1:scope:mine')).toBe('alice');
    expect(await runtime.store.get('cache:2:scope:mine')).toBe('bob');
  });

  it('shares one user’s cache across that user’s sessions', async () => {
    const runtime = createSlaRuntime(settings);
    const first = createSlaService(settings, runtime, () => Promise.resolve(1));
    const second = createSlaService(settings, runtime, () => Promise.resolve(1));
    const load = vi.fn(() => Promise.resolve('x'));
    await first.cached('scope:all', load);
    await second.cached('scope:all', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps preferences per user and applies them to that user only', async () => {
    const runtime = createSlaRuntime(settings);
    const alice = createSlaService(settings, runtime, () => Promise.resolve(1));
    const bob = createSlaService(settings, runtime, () => Promise.resolve(2));
    await alice.savePreferences({ reply: { warning: 30, critical: 10 } });
    expect(await alice.preferences()).toEqual({ reply: { warning: 30, critical: 10 } });
    expect(await runtime.store.get('prefs:1')).toEqual({ reply: { warning: 30, critical: 10 } });
    expect(await alice.thresholds()).toEqual({
      reply: { warning: 30, critical: 10 },
      wait: DEFAULT_SLA_THRESHOLDS.wait,
    });
    expect(await bob.preferences()).toBeUndefined();
    expect(await bob.thresholds()).toEqual(DEFAULT_SLA_THRESHOLDS);
  });

  it('applies the admin defaults to everyone when preferences are turned off', async () => {
    const off = { ...settings, slaUserPreferences: false };
    const service = createSlaService(off, createSlaRuntime(off), () => Promise.resolve(1));
    await service.savePreferences({ reply: { warning: 30, critical: 10 } });
    expect(service.userPreferencesAllowed).toBe(false);
    expect(service.adminThresholds).toEqual(DEFAULT_SLA_THRESHOLDS);
    expect(await service.thresholds()).toEqual(DEFAULT_SLA_THRESHOLDS);
  });

  it('reads an unreadable store as no preference', async () => {
    const runtime = createSlaRuntime(settings);
    runtime.store.get = () => Promise.reject(new Error('EIO'));
    const service = createSlaService(settings, runtime, () => Promise.resolve(1));
    expect(await service.preferences()).toBeUndefined();
    expect(await service.thresholds()).toEqual(DEFAULT_SLA_THRESHOLDS);
  });

  it('honours the configured cache lifetime', async () => {
    const runtime = createSlaRuntime({ slaCacheTtlSeconds: 0 });
    const service = createSlaService(settings, runtime, () => Promise.resolve(1));
    const load = vi.fn(() => Promise.resolve('x'));
    await service.cached('scope:all', load);
    await service.cached('scope:all', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('startSlaRuntime', () => {
  // configDir() reads XDG_CONFIG_HOME, or APPDATA on Windows: point both away.
  const saved = {
    XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
    APPDATA: process.env['APPDATA'],
  };
  const isolateConfigDir = (): void => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    process.env['XDG_CONFIG_HOME'] = dir;
    process.env['APPDATA'] = dir;
  };
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('puts the disk store next to the token files, under sla-state', async () => {
    isolateConfigDir();
    const { runtime, stop } = startSlaRuntime(makeConfig({ transport: 'stdio' }));
    try {
      await runtime.store.set('k', 1);
      expect(readdirSync(join(configDir(), 'sla-state'))).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('keeps an HTTP server in memory, writing nothing to disk', async () => {
    isolateConfigDir();
    const { runtime, stop } = startSlaRuntime(makeConfig({ transport: 'http' }));
    try {
      await runtime.store.set('k', 1);
      expect(await runtime.store.get('k')).toBe(1);
      expect(() => readdirSync(join(configDir(), 'sla-state'))).toThrow();
    } finally {
      stop();
    }
  });

  it('reads the cache lifetime in seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const runtime = createSlaRuntime({ slaCacheTtlSeconds: 60 });
      const load = vi.fn(() => Promise.resolve(1));
      await runtime.cache('k', load);
      vi.setSystemTime(Date.now() + 59_999);
      await runtime.cache('k', load);
      expect(load).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 1);
      await runtime.cache('k', load);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the configured cache lifetime', async () => {
    const { runtime, stop } = startSlaRuntime(
      makeConfig({ transport: 'http', slaCacheTtlSeconds: 0 }),
    );
    try {
      const load = vi.fn(() => Promise.resolve(1));
      await runtime.cache('k', load);
      await runtime.cache('k', load);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });
});
