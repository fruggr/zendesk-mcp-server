import { describe, expect, it } from 'vitest';
import type { ZendeskSlaLiveMetric } from '../../../src/types';
import { DEFAULT_SLA_THRESHOLDS } from '../../../src/utils/sla-thresholds';
import {
  classifyMetric,
  compareUrgency,
  formatUrgencyLine,
  type MetricUrgency,
  ticketUrgency,
} from '../../../src/utils/sla-urgency';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const inMinutes = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();
const metric = (
  name: string,
  minutes: number,
  stage = 'active',
): ZendeskSlaLiveMetric & { breach_at: string } => ({
  metric: name,
  stage,
  breach_at: inMinutes(minutes),
});
const classify = (m: ZendeskSlaLiveMetric) => classifyMetric(m, DEFAULT_SLA_THRESHOLDS, NOW);

describe('classifyMetric', () => {
  it.each([
    // reply family: warning 4h, critical 1h
    ['first_reply_time', 241, undefined],
    ['first_reply_time', 240, 'WARNING'],
    ['first_reply_time', 61, 'WARNING'],
    ['first_reply_time', 60, 'CRITICAL'],
    ['next_reply_time', 1, 'CRITICAL'],
    // wait family: warning 2d, critical 8h
    ['requester_wait_time', 2881, undefined],
    ['requester_wait_time', 2880, 'WARNING'],
    ['requester_wait_time', 481, 'WARNING'],
    ['agent_work_time', 480, 'CRITICAL'],
    ['unknown_metric', 2000, 'WARNING'],
  ])('%s due in %i min is %s', (name, minutes, level) => {
    expect(classify(metric(name, minutes))?.level).toBe(level);
  });

  it('reads a deadline that has passed as BREACHED, with negative minutes left', () => {
    expect(classify(metric('requester_wait_time', -90))).toEqual({
      metric: 'requester_wait_time',
      level: 'BREACHED',
      breachAt: inMinutes(-90),
      minutesLeft: -90,
    });
  });

  it('reads a deadline at this very instant as BREACHED', () => {
    expect(classify(metric('first_reply_time', 0))?.level).toBe('BREACHED');
  });

  it('counts a deadline 30 seconds away as zero minutes left, still CRITICAL', () => {
    const m = {
      metric: 'first_reply_time',
      stage: 'active',
      breach_at: new Date(NOW + 30_000).toISOString(),
    };
    expect(classify(m)).toMatchObject({ level: 'CRITICAL', minutesLeft: 0 });
  });

  it.each(['paused', 'achieved', 'fulfilled'])('ignores a %s metric', (stage) => {
    expect(classify(metric('first_reply_time', -10, stage))).toBeUndefined();
  });

  it('ignores a metric with no deadline or an unreadable one', () => {
    expect(
      classify({ metric: 'first_reply_time', stage: 'active', breach_at: null }),
    ).toBeUndefined();
    expect(
      classify({ metric: 'first_reply_time', stage: 'active', breach_at: 'soon' }),
    ).toBeUndefined();
  });

  it('honours custom thresholds per family', () => {
    const thresholds = {
      reply: { warning: 10, critical: 5 },
      wait: { warning: 100, critical: 50 },
    };
    expect(classifyMetric(metric('first_reply_time', 30), thresholds, NOW)).toBeUndefined();
    expect(classifyMetric(metric('requester_wait_time', 30), thresholds, NOW)?.level).toBe(
      'CRITICAL',
    );
  });
});

describe('compareUrgency', () => {
  const u = (level: MetricUrgency['level'], minutes: number): MetricUrgency => ({
    metric: 'm',
    level,
    breachAt: inMinutes(minutes),
    minutesLeft: minutes,
  });

  it('ranks by level first, then by the soonest breach', () => {
    const sorted = [u('WARNING', 100), u('CRITICAL', 30), u('BREACHED', -5), u('CRITICAL', 10)]
      .sort(compareUrgency)
      .map((x) => `${x.level}:${x.minutesLeft}`);
    expect(sorted).toEqual(['BREACHED:-5', 'CRITICAL:10', 'CRITICAL:30', 'WARNING:100']);
  });
});

describe('ticketUrgency', () => {
  it('returns the most urgent running metric', () => {
    const entry = {
      policy_metrics: [
        metric('requester_wait_time', 400),
        metric('first_reply_time', 30),
        metric('next_reply_time', -20, 'paused'),
      ],
    };
    expect(ticketUrgency(entry, DEFAULT_SLA_THRESHOLDS, NOW)?.metric).toBe('first_reply_time');
  });

  it('keeps the first of two equally urgent metrics', () => {
    const entry = {
      policy_metrics: [metric('next_reply_time', 30), metric('first_reply_time', 30)],
    };
    expect(ticketUrgency(entry, DEFAULT_SLA_THRESHOLDS, NOW)?.metric).toBe('next_reply_time');
  });

  it('returns undefined when nothing calls for attention, or there is no SLA', () => {
    const calm = { policy_metrics: [metric('first_reply_time', 600)] };
    expect(ticketUrgency(calm, DEFAULT_SLA_THRESHOLDS, NOW)).toBeUndefined();
    expect(ticketUrgency(undefined, DEFAULT_SLA_THRESHOLDS, NOW)).toBeUndefined();
  });
});

describe('formatUrgencyLine', () => {
  it('says how long is left before the breach', () => {
    expect(formatUrgencyLine(classify(metric('first_reply_time', 45)))).toBe(
      '- **Urgency**: CRITICAL — first_reply_time due in 45m',
    );
  });

  it('says how long a breached metric is overdue', () => {
    expect(formatUrgencyLine(classify(metric('requester_wait_time', -150)))).toBe(
      '- **Urgency**: BREACHED — requester_wait_time overdue by 2h30m',
    );
  });

  it('renders nothing when nothing is urgent', () => {
    expect(formatUrgencyLine(undefined)).toBe('');
  });
});
