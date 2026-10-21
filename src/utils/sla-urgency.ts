import type { ZendeskSlaLiveMetric, ZendeskSlaSideloadEntry } from '../types';
import { formatMinutes } from './durations';
import { hasPendingDeadline } from './formatting';
import { familyOf, type SlaThresholds } from './sla-thresholds';

/** Most urgent first: the order alerts are grouped and ranked in. */
export const URGENCY_LEVELS = ['BREACHED', 'CRITICAL', 'WARNING'] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export interface MetricUrgency {
  metric: string;
  level: UrgencyLevel;
  /** Zendesk's own `breach_at`, quoted as sent. */
  breachAt: string;
  /** Whole minutes to the breach; negative once it has passed. */
  minutesLeft: number;
}

const MINUTE_MS = 60_000;

/**
 * The urgency of one live SLA metric, or `undefined` when it does not call for
 * attention: not running (paused, achieved, fulfilled), no readable deadline,
 * or further away than its family's warning threshold. A deadline already
 * passed is BREACHED whatever the thresholds.
 */
export const classifyMetric = (
  m: ZendeskSlaLiveMetric,
  thresholds: SlaThresholds,
  now: number,
): MetricUrgency | undefined => {
  if (!hasPendingDeadline(m)) return undefined;
  // An unreadable `breach_at` parses to NaN, which fails every comparison below
  // and so falls through to `undefined` with no guard of its own.
  // Rounded, and breached below zero, exactly as the SLA block's metric line
  // (`formatSlaMetric`) counts them, so the two lines never disagree. `+ 0`
  // turns the -0 of a deadline under 30 s past into 0.
  const minutesLeft = Math.round((Date.parse(m.breach_at) - now) / MINUTE_MS) + 0;
  const { warning, critical } = thresholds[familyOf(m.metric)];
  let level: UrgencyLevel;
  if (minutesLeft < 0) level = 'BREACHED';
  else if (minutesLeft <= critical) level = 'CRITICAL';
  else if (minutesLeft <= warning) level = 'WARNING';
  else return undefined;
  return { metric: m.metric, level, breachAt: m.breach_at, minutesLeft };
};

/** Orders by level (BREACHED first), then by the soonest breach. */
export const compareUrgency = (a: MetricUrgency, b: MetricUrgency): number =>
  URGENCY_LEVELS.indexOf(a.level) - URGENCY_LEVELS.indexOf(b.level) ||
  Date.parse(a.breachAt) - Date.parse(b.breachAt);

/** The single most urgent running metric of a ticket, if any calls for attention. */
export const ticketUrgency = (
  entry: ZendeskSlaSideloadEntry | undefined,
  thresholds: SlaThresholds,
  now: number,
): MetricUrgency | undefined => {
  let worst: MetricUrgency | undefined;
  // Stryker disable next-line ArrayDeclaration: a placeholder element classifies as undefined, like no element at all.
  for (const m of entry?.policy_metrics ?? []) {
    const u = classifyMetric(m, thresholds, now);
    if (u && (!worst || compareUrgency(u, worst) < 0)) worst = u;
  }
  return worst;
};

/** `due in 45m` or `overdue by 2h`. */
export const formatDueIn = (u: MetricUrgency): string =>
  u.level === 'BREACHED'
    ? `overdue by ${formatMinutes(u.minutesLeft)}`
    : `due in ${formatMinutes(u.minutesLeft)}`;

/**
 * The `**Urgency**` line pushed into a ticket's SLA block, or '' when nothing is
 * urgent, so the caller can pass it on unconditionally.
 */
export const formatUrgencyLine = (u: MetricUrgency | undefined): string =>
  u ? `- **Urgency**: ${u.level} — ${u.metric} ${formatDueIn(u)}` : '';
