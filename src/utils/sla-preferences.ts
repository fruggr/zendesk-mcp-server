import { formatMinutes, notADuration, parseDuration } from './durations';
import {
  formatThreshold,
  type SlaFamily,
  type SlaThreshold,
  type SlaThresholds,
} from './sla-thresholds';

/**
 * One user's stored SLA alert preferences. A family left out follows the
 * server default; `introduced` records that the user has been shown how the
 * thresholds work, so the alert tool does not explain them again.
 */
export interface SlaPreferences {
  reply?: SlaThreshold;
  wait?: SlaThreshold;
  introduced?: boolean;
}

export const SLA_FAMILIES: readonly SlaFamily[] = ['reply', 'wait'];

const FAMILY_LABEL: Record<SlaFamily, string> = {
  reply: 'Reply metrics (first_reply_time, next_reply_time)',
  wait: 'Wait and resolution metrics (every other metric)',
};

/** Personal thresholds where set (and allowed), the server default elsewhere. */
export const effectiveThresholds = (
  admin: SlaThresholds,
  prefs: SlaPreferences | undefined,
): SlaThresholds => ({
  reply: prefs?.reply ?? admin.reply,
  wait: prefs?.wait ?? admin.wait,
});

/** A change asked of `configure_sla_alerts`, every field optional. */
export interface SlaPreferenceChange {
  reply_warning?: string | undefined;
  reply_critical?: string | undefined;
  wait_warning?: string | undefined;
  wait_critical?: string | undefined;
  reset?: 'reply' | 'wait' | 'all' | undefined;
}

export const isEmptyChange = (change: SlaPreferenceChange): boolean =>
  Object.values(change).every((value) => value === undefined);

const readDuration = (raw: string | undefined, field: string): number | string | undefined => {
  if (raw === undefined) return undefined;
  const minutes = parseDuration(raw);
  return minutes === undefined ? `${field}: ${notADuration(raw)}` : minutes;
};

type FamilyOutcome = 'keep' | 'reset' | SlaThreshold | { error: string };

// What a change asks of one family: nothing, a reset, or a new threshold.
const changeFamily = (
  family: SlaFamily,
  current: SlaThreshold,
  change: SlaPreferenceChange,
): FamilyOutcome => {
  const warning = readDuration(change[`${family}_warning`], `${family}_warning`);
  const critical = readDuration(change[`${family}_critical`], `${family}_critical`);
  if (typeof warning === 'string') return { error: warning };
  if (typeof critical === 'string') return { error: critical };
  const given = warning !== undefined || critical !== undefined;
  if (change.reset === family || change.reset === 'all') {
    return given
      ? { error: `Either reset the ${family} thresholds or set them, not both.` }
      : 'reset';
  }
  if (!given) return 'keep';
  const threshold = { warning: warning ?? current.warning, critical: critical ?? current.critical };
  if (threshold.critical > threshold.warning) {
    return {
      error: `The ${family} critical threshold (${formatMinutes(threshold.critical)}) must not be longer than its warning one (${formatMinutes(threshold.warning)}).`,
    };
  }
  return threshold;
};

/**
 * Applies a change to the stored preferences. A half given alone keeps the
 * other half in force (personal, else server default); a family reset goes
 * back to the server default, and `all` also forgets the user was introduced. Returns the new preferences, or why the change
 * is refused.
 */
export const applyPreferenceChange = (
  admin: SlaThresholds,
  prefs: SlaPreferences | undefined,
  change: SlaPreferenceChange,
): { preferences: SlaPreferences } | { error: string } => {
  const current = effectiveThresholds(admin, prefs);
  // Resetting everything starts over, introduction included.
  const next: SlaPreferences = change.reset === 'all' ? {} : { ...prefs };
  for (const family of SLA_FAMILIES) {
    const outcome = changeFamily(family, current[family], change);
    if (outcome === 'reset') delete next[family];
    else if (outcome === 'keep') continue;
    else if ('error' in outcome) return outcome;
    else next[family] = outcome;
  }
  return { preferences: next };
};

const sourceOf = (
  family: SlaFamily,
  prefs: SlaPreferences | undefined,
  allowed: boolean,
  admin: SlaThresholds,
): string =>
  allowed && prefs?.[family]
    ? `your preference (server default: ${formatThreshold(admin[family])})`
    : 'server default';

/**
 * The thresholds in force for the caller, where each comes from, and how they
 * are applied. Shared by `configure_sla_alerts` and the alert tool's
 * first-call explanation.
 */
export const describeEffectiveThresholds = (
  admin: SlaThresholds,
  prefs: SlaPreferences | undefined,
  allowed: boolean,
): string => {
  const inForce = effectiveThresholds(admin, allowed ? prefs : undefined);
  return [
    'SLA alert thresholds in force for you:',
    ...SLA_FAMILIES.map(
      (family) =>
        `- ${FAMILY_LABEL[family]}: ${formatThreshold(inForce[family])} — ${sourceOf(family, prefs, allowed, admin)}`,
    ),
    'A running metric turns WARNING when its breach is closer than the warning threshold, CRITICAL when closer than the critical one, and BREACHED once its deadline has passed. Paused and achieved metrics never alert.',
    allowed
      ? 'Change them with configure_sla_alerts (reply_warning, reply_critical, wait_warning, wait_critical), or go back to the server defaults with reset.'
      : 'Personal thresholds are turned off on this server (SLA_USER_PREFERENCES=off): the server defaults apply to everyone.',
  ].join('\n');
};
