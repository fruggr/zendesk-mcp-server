import { join } from 'node:path';
import { configDir } from '../auth/token-persistence';
import { zendeskGet } from '../client/zendesk-api';
import { type Config, slaStateStoreOf } from '../config';
import { createScopeCache, type ScopeCache } from './scope-cache';
import { effectiveThresholds, type SlaPreferences } from './sla-preferences';
import type { SlaThresholds } from './sla-thresholds';
import { createDiskStore, createMemoryStore, type StateStore, startSweeper } from './state-store';

/**
 * What the tools need to know about SLA alerting for the caller: whether the
 * server pushes urgency on its own, the thresholds in force, and the caller's
 * own slice of the shared state.
 */
export interface SlaService {
  push: boolean;
  /** Whether users may set personal thresholds (`SLA_USER_PREFERENCES`). */
  userPreferencesAllowed: boolean;
  /** The operator's defaults, before any personal preference. */
  adminThresholds: SlaThresholds;
  /** The thresholds in force for the caller: personal where allowed and set, else the admin's. */
  thresholds: () => Promise<SlaThresholds>;
  /** The caller's stored preferences, whether or not the server currently honours them. */
  preferences: () => Promise<SlaPreferences | undefined>;
  savePreferences: (preferences: SlaPreferences) => Promise<void>;
  /** The caller's Zendesk user id, the key of every piece of per-user state. */
  userId: () => Promise<number>;
  /** `load()` served from the caller's cache entry for `scope`, shared while in flight. */
  cached: <T>(scope: string, load: () => Promise<T>) => Promise<T>;
}

export interface SlaSettings {
  /** Part of every key: one disk store serves every stdio server of the machine, whatever its tenant. */
  subdomain: string;
  slaPush: boolean;
  slaThresholds: SlaThresholds;
  slaCacheTtlSeconds: number;
  slaUserPreferences: boolean;
}

/**
 * The state one process keeps for every session it serves: on HTTP the
 * sessions of all users share it, which is why every key carries a user id.
 */
export interface SlaRuntime {
  store: StateStore;
  cache: ScopeCache;
}

export const createSlaRuntime = (
  settings: Pick<SlaSettings, 'slaCacheTtlSeconds'>,
  store: StateStore = createMemoryStore(),
): SlaRuntime => ({
  store,
  cache: createScopeCache(store, settings.slaCacheTtlSeconds * 1000),
});

/**
 * The runtime the entry point builds once per process: the store the config
 * selects, next to the token files when on disk, swept in the background.
 * `stop` ends the sweeper.
 */
export const startSlaRuntime = (config: Config): { runtime: SlaRuntime; stop: () => void } => {
  const store =
    slaStateStoreOf(config) === 'disk'
      ? createDiskStore(join(configDir(), 'sla-state'))
      : createMemoryStore();
  return { runtime: createSlaRuntime(config, store), stop: startSweeper(store) };
};

// A token refresh changes the key; the few superseded entries are dropped
// oldest first rather than kept for the life of the process.
const MAX_REMEMBERED_TOKENS = 8;

/**
 * Resolves the caller's Zendesk user id once per token (`/users/me`), so a
 * refreshed or another user's token can never read an entry cached under the
 * previous one. A failed lookup is forgotten, to be retried on the next call.
 */
export const createUserIdResolver = (
  subdomain: string,
  getToken: () => string | Promise<string>,
): (() => Promise<number>) => {
  const byToken = new Map<string, Promise<number>>();
  return async () => {
    const token = await getToken();
    const known = byToken.get(token);
    if (known) return known;
    const lookup = zendeskGet<{ user: { id: number } }>(subdomain, token, '/users/me').then(
      ({ user }) => user.id,
    );
    lookup.catch(() => byToken.delete(token));
    if (byToken.size >= MAX_REMEMBERED_TOKENS)
      byToken.delete(byToken.keys().next().value as string);
    byToken.set(token, lookup);
    return lookup;
  };
};

export const createSlaService = (
  settings: SlaSettings,
  runtime: SlaRuntime,
  userId: () => Promise<number>,
): SlaService => {
  const userKey = async (): Promise<string> => `${settings.subdomain}:${await userId()}`;
  // Rejects when the store cannot be read: a write built on "no preference"
  // would overwrite the stored ones.
  const preferences = async (): Promise<SlaPreferences | undefined> =>
    (await runtime.store.get(`prefs:${await userKey()}`)) as SlaPreferences | undefined;
  return {
    push: settings.slaPush,
    userPreferencesAllowed: settings.slaUserPreferences,
    adminThresholds: settings.slaThresholds,
    // Display only: when the caller's preferences cannot be read, the defaults still alert.
    thresholds: async () =>
      settings.slaUserPreferences
        ? preferences().then(
            (prefs) => effectiveThresholds(settings.slaThresholds, prefs),
            () => settings.slaThresholds,
          )
        : settings.slaThresholds,
    preferences,
    savePreferences: async (prefs) => runtime.store.set(`prefs:${await userKey()}`, prefs),
    userId,
    cached: async (scope, load) => runtime.cache(`cache:${await userKey()}:${scope}`, load),
  };
};
