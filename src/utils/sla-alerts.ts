import type { ZendeskSlaLiveMetric, ZendeskTicket } from '../types';
import type { SlaThresholds } from './sla-thresholds';
import { classifyMetric, formatDueIn, type MetricUrgency, URGENCY_LEVELS } from './sla-urgency';

/**
 * The slice of a ticket the alerts need, small enough to cache per user and
 * JSON-safe for the disk store.
 */
export interface AlertTicket {
  id: number;
  subject: string;
  status: string;
  priority: string | null;
  metrics: ZendeskSlaLiveMetric[];
}

/** What one scope fetch found: the tickets read, and whether some were left unread. */
export interface ScopeSnapshot {
  tickets: AlertTicket[];
  /** Whether the scope holds tickets beyond those read (the page cap was hit). */
  truncated: boolean;
  /** How many, when Zendesk said; 0 when it did not. */
  unread: number;
}

export const toAlertTicket = (ticket: ZendeskTicket): AlertTicket => ({
  id: ticket.id,
  subject: ticket.subject,
  status: ticket.status,
  priority: ticket.priority,
  metrics: ticket.slas?.policy_metrics ?? [],
});

/** Several fetches into one snapshot, each ticket once (a ticket can sit in two groups). */
export const mergeSnapshots = (snapshots: ScopeSnapshot[]): ScopeSnapshot => {
  const byId = new Map<number, AlertTicket>();
  for (const snapshot of snapshots) {
    for (const ticket of snapshot.tickets) if (!byId.has(ticket.id)) byId.set(ticket.id, ticket);
  }
  return {
    tickets: [...byId.values()],
    truncated: snapshots.some((s) => s.truncated),
    unread: snapshots.reduce((sum, s) => sum + s.unread, 0),
  };
};

export interface Alert {
  ticket: AlertTicket;
  urgency: MetricUrgency;
}

export interface AlertFilter {
  /** Keep only alerts breaching within this many minutes (breached ones aside). */
  withinMinutes?: number | undefined;
  includeBreached: boolean;
}

/**
 * Every running metric that is breached or inside its family's thresholds, one
 * alert per metric, most urgent level first and soonest breach first within it.
 */
export const selectAlerts = (
  tickets: AlertTicket[],
  thresholds: SlaThresholds,
  now: number,
  filter: AlertFilter,
): Alert[] =>
  tickets
    .flatMap((ticket) =>
      ticket.metrics.flatMap((m) => {
        const urgency = classifyMetric(m, thresholds, now);
        return urgency ? [{ ticket, urgency }] : [];
      }),
    )
    .filter(({ urgency }) =>
      urgency.level === 'BREACHED'
        ? filter.includeBreached
        : filter.withinMinutes === undefined || urgency.minutesLeft <= filter.withinMinutes,
    )
    .sort(
      (a, b) =>
        URGENCY_LEVELS.indexOf(a.urgency.level) - URGENCY_LEVELS.indexOf(b.urgency.level) ||
        Date.parse(a.urgency.breachAt) - Date.parse(b.urgency.breachAt) ||
        a.ticket.id - b.ticket.id,
    );

/**
 * What a subscriber is notified about: which ticket, which metric, which
 * level. The minutes counting down are left out on purpose, or every poll
 * would read as a change.
 */
export const alertFingerprint = (alerts: Alert[]): string =>
  alerts
    .map(({ ticket, urgency }) => `${ticket.id}:${urgency.metric}:${urgency.level}`)
    .sort((a, b) => a.localeCompare(b))
    .join('|');

const formatAlert = ({ ticket, urgency }: Alert): string =>
  `- #${ticket.id} ${urgency.metric} ${formatDueIn(urgency)} (due ${urgency.breachAt}) — "${ticket.subject}" [${ticket.status}, ${ticket.priority ?? 'no priority'}]`;

export interface AlertReport {
  /** Who and what was checked, e.g. `your assigned tickets`. */
  scopeLabel: string;
  checked: number;
  truncated: boolean;
  unread: number;
  /** The thresholds line, already rendered. */
  thresholds: string;
  /** Lines said before the alerts: defaults taken, first-call explanation. */
  notes: string[];
  maxLines: number;
}

/**
 * The compact report: a summary line, the thresholds, then one line per alert
 * grouped by level. Past `maxLines` alerts, the rest are counted, not listed.
 */
export const renderAlerts = (alerts: Alert[], report: AlertReport): string => {
  const counts = URGENCY_LEVELS.map(
    (level) => `${alerts.filter((a) => a.urgency.level === level).length} ${level.toLowerCase()}`,
  ).join(', ');
  const lines = [
    `SLA alerts for ${report.scopeLabel}: ${counts} (${report.checked} ticket(s) checked).`,
    `Thresholds: ${report.thresholds}.`,
  ];
  if (report.truncated) {
    const howMany = report.unread > 0 ? `${report.unread} more ticket(s)` : 'More tickets';
    lines.push(
      `Truncated: ${howMany} in this scope were not read. Narrow it with query or view to see them.`,
    );
  }
  for (const note of report.notes) lines.push(note);
  if (alerts.length === 0) {
    lines.push('', 'No running SLA metric is breached or within its thresholds.');
    return lines.join('\n');
  }
  const shown = alerts.slice(0, report.maxLines);
  for (const level of URGENCY_LEVELS) {
    const group = shown.filter((a) => a.urgency.level === level);
    if (group.length > 0) lines.push('', `## ${level}`, ...group.map(formatAlert));
  }
  const hidden = alerts.length - shown.length;
  if (hidden > 0) {
    lines.push(
      '',
      `${hidden} more alert(s) not listed. Narrow the scope with query or view, or shorten within.`,
    );
  }
  return lines.join('\n');
};
