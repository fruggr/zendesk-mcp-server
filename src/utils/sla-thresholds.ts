import { formatMinutes, notADuration, parseDuration } from './durations';

/**
 * SLA metrics fall in two families with their own alert thresholds: a reply is
 * due within hours, a wait or resolution within days. A metric we do not know
 * lands in `wait`, the family with the wider window, so a new Zendesk metric
 * alerts late rather than flooding.
 */
export type SlaFamily = 'reply' | 'wait';

const REPLY_METRICS: ReadonlySet<string> = new Set(['first_reply_time', 'next_reply_time']);

export const familyOf = (metric: string): SlaFamily =>
  REPLY_METRICS.has(metric) ? 'reply' : 'wait';

/** Minutes left before a breach at which a metric turns WARNING, then CRITICAL. */
export interface SlaThreshold {
  warning: number;
  critical: number;
}

export type SlaThresholds = Record<SlaFamily, SlaThreshold>;

export const DEFAULT_SLA_THRESHOLDS: SlaThresholds = {
  reply: { warning: 4 * 60, critical: 60 },
  wait: { warning: 2 * 24 * 60, critical: 8 * 60 },
};

/**
 * Checks a warning/critical pair given as readable durations. Returns the pair
 * in minutes, or the reason it is refused: a critical window wider than the
 * warning one would never show a WARNING.
 */
export const toThreshold = (
  warning: string,
  critical: string,
): { threshold: SlaThreshold } | { error: string } => {
  const w = parseDuration(warning);
  const c = parseDuration(critical);
  if (w === undefined || c === undefined) {
    return { error: notADuration(w === undefined ? warning : critical) };
  }
  if (c > w) {
    return {
      error: `The critical threshold (${critical}) must not be longer than the warning one (${warning}).`,
    };
  }
  return { threshold: { warning: w, critical: c } };
};

/** Reads the `warning,critical` form of the admin variables (`4h,1h`). */
export const parseThresholdPair = (
  raw: string,
): { threshold: SlaThreshold } | { error: string } => {
  const parts = raw.split(',').map((part) => part.trim());
  const [warning, critical] = parts;
  if (parts.length !== 2 || !warning || !critical) {
    return { error: 'Expected two durations separated by a comma, warning first: 4h,1h.' };
  }
  return toThreshold(warning, critical);
};

export const formatThreshold = (t: SlaThreshold): string =>
  `warning ${formatMinutes(t.warning)}, critical ${formatMinutes(t.critical)}`;

/** One line naming both families' thresholds, as the alerts and the tools report them. */
export const describeThresholds = (t: SlaThresholds): string =>
  `reply metrics ${formatThreshold(t.reply)}; wait and resolution metrics ${formatThreshold(t.wait)}`;
