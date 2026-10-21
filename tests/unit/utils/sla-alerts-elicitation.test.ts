import { describe, expect, it } from 'vitest';
import {
  buildAlertsElicitation,
  overrideThresholds,
  readAlertsAnswer,
} from '../../../src/utils/sla-alerts-elicitation';
import { DEFAULT_SLA_THRESHOLDS } from '../../../src/utils/sla-thresholds';

const T = DEFAULT_SLA_THRESHOLDS;

describe('buildAlertsElicitation', () => {
  it('asks nothing when the scope is known and the user was introduced', () => {
    expect(
      buildAlertsElicitation({ askScope: false, introduce: false, thresholds: T }),
    ).toBeUndefined();
  });

  it('asks only the scope, required, with the three named sets', () => {
    expect(buildAlertsElicitation({ askScope: true, introduce: false, thresholds: T })).toEqual({
      message: 'Which tickets should be checked for SLA alerts?',
      requestedSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            title: 'Tickets to check',
            oneOf: [
              { const: 'mine', title: 'My assigned tickets' },
              { const: 'my_groups', title: "My groups' tickets" },
              { const: 'all', title: 'All unsolved tickets' },
            ],
            default: 'mine',
          },
        },
        required: ['scope'],
      },
    });
  });

  it('explains and offers the thresholds in force on a first call', () => {
    const form = buildAlertsElicitation({
      askScope: false,
      introduce: true,
      thresholds: { ...T, wait: { warning: 1440, critical: 90 } },
    });
    expect(form?.message).toBe(
      'A running SLA metric is flagged WARNING when its breach is closer than the warning threshold, CRITICAL when closer than the critical one, and BREACHED once overdue. In force for you: reply metrics (first_reply_time, next_reply_time) 4h,1h, every other metric 1d,1h30m, as warning,critical. Edits here apply to this call only; configure_sla_alerts keeps them.',
    );
    expect(form?.requestedSchema).toEqual({
      type: 'object',
      properties: {
        reply_thresholds: {
          type: 'string',
          title: 'Reply metrics: warning,critical',
          default: '4h,1h',
        },
        wait_thresholds: {
          type: 'string',
          title: 'Wait and resolution metrics: warning,critical',
          default: '1d,1h30m',
        },
      },
    });
  });

  it('asks both in one form, scope first', () => {
    const form = buildAlertsElicitation({ askScope: true, introduce: true, thresholds: T });
    expect(Object.keys(form?.requestedSchema.properties ?? {})).toEqual([
      'scope',
      'reply_thresholds',
      'wait_thresholds',
    ]);
    expect(
      form?.message.startsWith('Which tickets should be checked for SLA alerts?\n\nA running'),
    ).toBe(true);
    expect(form?.requestedSchema.required).toEqual(['scope']);
  });
});

describe('readAlertsAnswer', () => {
  it('takes a known scope and ignores anything else', () => {
    expect(readAlertsAnswer({ scope: 'my_groups' }, T).scope).toBe('my_groups');
    expect(readAlertsAnswer({ scope: 'everything' }, T).scope).toBeUndefined();
    expect(readAlertsAnswer({ scope: 3 }, T).scope).toBeUndefined();
  });

  it('turns edited thresholds into a preference change', () => {
    expect(readAlertsAnswer({ reply_thresholds: '2h,15m', wait_thresholds: '3d,1d' }, T)).toEqual({
      change: {
        reply_warning: '2h',
        reply_critical: '15m',
        wait_warning: '3d',
        wait_critical: '1d',
      },
      notes: [],
    });
  });

  it('changes nothing for thresholds sent back as offered', () => {
    expect(readAlertsAnswer({ reply_thresholds: ' 4h,1h ', wait_thresholds: '2d,8h' }, T)).toEqual({
      change: {},
      notes: [],
    });
  });

  it('notes a threshold it cannot read and keeps the rest', () => {
    expect(readAlertsAnswer({ reply_thresholds: 'soon', wait_thresholds: '3d,1d' }, T)).toEqual({
      change: { wait_warning: '3d', wait_critical: '1d' },
      notes: [
        'Your reply thresholds "soon" were not applied: Expected two durations separated by a comma, warning first: 4h,1h.',
      ],
    });
  });

  it('ignores a threshold field that is not text', () => {
    expect(readAlertsAnswer({ wait_thresholds: 5 }, T)).toEqual({ change: {}, notes: [] });
  });
});

describe('overrideThresholds', () => {
  it('leaves the thresholds alone when nothing is overridden', () => {
    expect(overrideThresholds(T, undefined, undefined)).toEqual({ thresholds: T });
  });

  it('applies both overrides to both families', () => {
    expect(overrideThresholds(T, '1d', '1h')).toEqual({
      thresholds: { reply: { warning: 1440, critical: 60 }, wait: { warning: 1440, critical: 60 } },
    });
  });

  it('takes a lone warning as is, lowering a critical that would exceed it', () => {
    expect(overrideThresholds(T, '2h', undefined)).toEqual({
      thresholds: { reply: { warning: 120, critical: 60 }, wait: { warning: 120, critical: 120 } },
    });
    expect(overrideThresholds(T, '9h', undefined)).toEqual({
      thresholds: { reply: { warning: 540, critical: 60 }, wait: { warning: 540, critical: 480 } },
    });
  });

  it('takes a lone critical as is, raising a warning that would fall under it', () => {
    expect(overrideThresholds(T, undefined, '5h')).toEqual({
      thresholds: {
        reply: { warning: 300, critical: 300 },
        wait: { warning: 2880, critical: 300 },
      },
    });
    expect(overrideThresholds(T, undefined, '30m')).toEqual({
      thresholds: { reply: { warning: 240, critical: 30 }, wait: { warning: 2880, critical: 30 } },
    });
  });

  it('refuses a pair whose critical is above its warning', () => {
    expect(overrideThresholds(T, '1h', '2h')).toEqual({
      error: 'The critical threshold (2h) must not be longer than the warning one (1h).',
    });
  });

  it('refuses an unreadable override, alone or in a pair', () => {
    const notADuration = (raw: string) => ({
      error: `"${raw}" is not a duration. Use a number and a unit: 30m, 4h, 2d, 1w, or a mix like 1d4h.`,
    });
    expect(overrideThresholds(T, 'x', undefined)).toEqual(notADuration('x'));
    expect(overrideThresholds(T, undefined, 'y')).toEqual(notADuration('y'));
    expect(overrideThresholds(T, '1h', 'y')).toEqual(notADuration('y'));
  });
});
