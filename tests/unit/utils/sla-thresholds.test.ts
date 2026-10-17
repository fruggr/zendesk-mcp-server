import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SLA_THRESHOLDS,
  describeThresholds,
  familyOf,
  formatThreshold,
  parseThresholdPair,
  toThreshold,
} from '../../../src/utils/sla-thresholds';

describe('familyOf', () => {
  it.each([
    ['first_reply_time', 'reply'],
    ['next_reply_time', 'reply'],
    ['requester_wait_time', 'wait'],
    ['agent_work_time', 'wait'],
    ['periodic_update_time', 'wait'],
    ['some_future_metric', 'wait'],
  ])('puts %s in the %s family', (metric, family) => {
    expect(familyOf(metric)).toBe(family);
  });
});

describe('DEFAULT_SLA_THRESHOLDS', () => {
  it('is 4h/1h for replies and 2d/8h for waits', () => {
    expect(DEFAULT_SLA_THRESHOLDS).toEqual({
      reply: { warning: 240, critical: 60 },
      wait: { warning: 2880, critical: 480 },
    });
  });
});

describe('toThreshold', () => {
  it('reads both durations in minutes', () => {
    expect(toThreshold('1d', '2h')).toEqual({ threshold: { warning: 1440, critical: 120 } });
  });

  it('accepts equal windows', () => {
    expect(toThreshold('2h', '2h')).toEqual({ threshold: { warning: 120, critical: 120 } });
  });

  it('refuses a critical window wider than the warning one', () => {
    expect(toThreshold('1h', '2h')).toEqual({
      error: 'The critical threshold (2h) must not be longer than the warning one (1h).',
    });
  });

  it('names the duration it cannot read, warning first', () => {
    expect(toThreshold('soon', '2h')).toEqual({
      error:
        '"soon" is not a duration. Use a number and a unit: 30m, 4h, 2d, 1w, or a mix like 1d4h.',
    });
    expect(toThreshold('4h', 'later')).toEqual({
      error:
        '"later" is not a duration. Use a number and a unit: 30m, 4h, 2d, 1w, or a mix like 1d4h.',
    });
  });
});

describe('parseThresholdPair', () => {
  it('reads warning,critical with spaces around the comma', () => {
    expect(parseThresholdPair(' 4h , 1h ')).toEqual({ threshold: { warning: 240, critical: 60 } });
  });

  it.each(['4h', '4h,', ',1h', '4h, ', ' ,1h', '4h,1h,30m', ''])('refuses %j', (raw) => {
    expect(parseThresholdPair(raw)).toEqual({
      error: 'Expected two durations separated by a comma, warning first: 4h,1h.',
    });
  });

  it('passes the duration checks through', () => {
    expect(parseThresholdPair('1h,2h')).toEqual({
      error: 'The critical threshold (2h) must not be longer than the warning one (1h).',
    });
  });
});

describe('formatting', () => {
  it('renders one family', () => {
    expect(formatThreshold({ warning: 1500, critical: 30 })).toBe('warning 1d1h, critical 30m');
  });

  it('renders both families', () => {
    expect(describeThresholds(DEFAULT_SLA_THRESHOLDS)).toBe(
      'reply metrics warning 4h, critical 1h; wait and resolution metrics warning 2d, critical 8h',
    );
  });
});
