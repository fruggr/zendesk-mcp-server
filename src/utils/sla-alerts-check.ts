import { type AlertFilter, alertFingerprint, renderAlerts, selectAlerts } from './sla-alerts';
import type { SlaPreferences } from './sla-preferences';
import { fetchScope, type SlaScope, scopeKey, scopeLabel, type ZendeskGetter } from './sla-scope';
import type { SlaService } from './sla-service';
import { describeThresholds, type SlaThresholds } from './sla-thresholds';

/** Alert lines listed before the rest are only counted. */
export const MAX_ALERT_LINES = 100;

/** Where the thresholds in force come from, as the report states it. */
export const thresholdsSource = (
  sla: Pick<SlaService, 'userPreferencesAllowed'>,
  prefs: SlaPreferences | undefined,
  overridden: boolean,
): string => {
  if (overridden) return 'overridden for this call';
  if (!sla.userPreferencesAllowed) return 'server default';
  return prefs?.reply || prefs?.wait
    ? 'yours; change them with configure_sla_alerts'
    : 'server default; set your own with configure_sla_alerts';
};

export interface AlertsCheckInput {
  sla: SlaService;
  get: ZendeskGetter;
  target: SlaScope;
  thresholds: SlaThresholds;
  /** See `thresholdsSource`. */
  source: string;
  filter: AlertFilter;
  notes: string[];
}

/**
 * One alert check, as the tool, a resource read and the poller all run it:
 * the scope read through the caller's cache, the alerts selected and
 * rendered, and their fingerprint for change detection.
 */
export const checkAlerts = async (
  input: AlertsCheckInput,
): Promise<{ text: string; fingerprint: string }> => {
  const { sla, get, target } = input;
  const snapshot = await sla.cached(scopeKey(target), () => fetchScope(target, get, sla.userId));
  const alerts = selectAlerts(snapshot.tickets, input.thresholds, Date.now(), input.filter);
  return {
    fingerprint: alertFingerprint(alerts),
    text: renderAlerts(alerts, {
      scopeLabel: scopeLabel(target),
      checked: snapshot.tickets.length,
      truncated: snapshot.truncated,
      unread: snapshot.unread,
      thresholds: `${describeThresholds(input.thresholds)} (${input.source})`,
      notes: input.notes,
      maxLines: MAX_ALERT_LINES,
    }),
  };
};
