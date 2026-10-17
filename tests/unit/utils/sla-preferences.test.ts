import { describe, expect, it } from 'vitest';
import {
  applyPreferenceChange,
  describeEffectiveThresholds,
  effectiveThresholds,
  isEmptyChange,
} from '../../../src/utils/sla-preferences';
import { DEFAULT_SLA_THRESHOLDS } from '../../../src/utils/sla-thresholds';

const ADMIN = DEFAULT_SLA_THRESHOLDS;

describe('effectiveThresholds', () => {
  it('takes each family from the preferences when set, else from the admin', () => {
    expect(effectiveThresholds(ADMIN, { wait: { warning: 100, critical: 10 } })).toEqual({
      reply: ADMIN.reply,
      wait: { warning: 100, critical: 10 },
    });
    expect(effectiveThresholds(ADMIN, { reply: { warning: 30, critical: 5 } })).toEqual({
      reply: { warning: 30, critical: 5 },
      wait: ADMIN.wait,
    });
    expect(effectiveThresholds(ADMIN, undefined)).toEqual(ADMIN);
  });
});

describe('isEmptyChange', () => {
  it('is true only when no field carries a value', () => {
    expect(isEmptyChange({})).toBe(true);
    expect(isEmptyChange({ reply_warning: undefined })).toBe(true);
    expect(isEmptyChange({ reset: 'all' })).toBe(false);
    expect(isEmptyChange({ wait_critical: '1h' })).toBe(false);
  });
});

describe('applyPreferenceChange', () => {
  it('sets both halves of a family', () => {
    expect(
      applyPreferenceChange(ADMIN, undefined, { reply_warning: '2h', reply_critical: '30m' }),
    ).toEqual({ preferences: { reply: { warning: 120, critical: 30 } } });
  });

  it('keeps the other half in force when only one is given', () => {
    expect(applyPreferenceChange(ADMIN, undefined, { wait_critical: '4h' })).toEqual({
      preferences: { wait: { warning: 2880, critical: 240 } },
    });
    expect(
      applyPreferenceChange(
        ADMIN,
        { wait: { warning: 600, critical: 60 } },
        { wait_warning: '1d' },
      ),
    ).toEqual({ preferences: { wait: { warning: 1440, critical: 60 } } });
  });

  it('keeps what it does not touch, including the introduction marker', () => {
    expect(
      applyPreferenceChange(
        ADMIN,
        { introduced: true, wait: { warning: 600, critical: 60 } },
        { reply_warning: '3h' },
      ),
    ).toEqual({
      preferences: {
        introduced: true,
        wait: { warning: 600, critical: 60 },
        reply: { warning: 180, critical: 60 },
      },
    });
  });

  it('resets one family or both', () => {
    const prefs = {
      introduced: true,
      reply: { warning: 1, critical: 1 },
      wait: { warning: 2, critical: 2 },
    };
    expect(applyPreferenceChange(ADMIN, prefs, { reset: 'reply' })).toEqual({
      preferences: { introduced: true, wait: { warning: 2, critical: 2 } },
    });
    expect(applyPreferenceChange(ADMIN, prefs, { reset: 'wait' })).toEqual({
      preferences: { introduced: true, reply: { warning: 1, critical: 1 } },
    });
    expect(applyPreferenceChange(ADMIN, prefs, { reset: 'all' })).toEqual({
      preferences: { introduced: true },
    });
  });

  it('lets a reset of one family go with a change to the other', () => {
    expect(
      applyPreferenceChange(
        ADMIN,
        { reply: { warning: 1, critical: 1 } },
        {
          reset: 'reply',
          wait_warning: '3d',
        },
      ),
    ).toEqual({ preferences: { wait: { warning: 4320, critical: 480 } } });
  });

  it('refuses to reset and set the same family', () => {
    expect(applyPreferenceChange(ADMIN, undefined, { reset: 'all', wait_critical: '1h' })).toEqual({
      error: 'Either reset the wait thresholds or set them, not both.',
    });
    expect(
      applyPreferenceChange(ADMIN, undefined, { reset: 'reply', reply_warning: '1h' }),
    ).toEqual({ error: 'Either reset the reply thresholds or set them, not both.' });
  });

  it('accepts a critical window as wide as the warning one', () => {
    expect(applyPreferenceChange(ADMIN, undefined, { reply_critical: '4h' })).toEqual({
      preferences: { reply: { warning: 240, critical: 240 } },
    });
  });

  it('refuses a critical window wider than the warning one, after merging', () => {
    expect(applyPreferenceChange(ADMIN, undefined, { reply_critical: '5h' })).toEqual({
      error: 'The reply critical threshold (5h) must not be longer than its warning one (4h).',
    });
  });

  it('names the field it cannot read', () => {
    expect(applyPreferenceChange(ADMIN, undefined, { wait_warning: 'soon' })).toEqual({
      error:
        'wait_warning: "soon" is not a duration. Use a number and a unit: 30m, 4h, 2d, 1w, or a mix like 1d4h.',
    });
    expect(applyPreferenceChange(ADMIN, undefined, { reply_critical: '1x' })).toEqual({
      error:
        'reply_critical: "1x" is not a duration. Use a number and a unit: 30m, 4h, 2d, 1w, or a mix like 1d4h.',
    });
  });
});

describe('describeEffectiveThresholds', () => {
  it('says where each threshold comes from and how to change them', () => {
    expect(
      describeEffectiveThresholds(ADMIN, { wait: { warning: 1440, critical: 120 } }, true),
    ).toMatchInlineSnapshot(`
      "SLA alert thresholds in force for you:
      - Reply metrics (first_reply_time, next_reply_time): warning 4h, critical 1h — server default
      - Wait and resolution metrics (every other metric): warning 1d, critical 2h — your preference (server default: warning 2d, critical 8h)
      A running metric turns WARNING when its breach is closer than the warning threshold, CRITICAL when closer than the critical one, and BREACHED once its deadline has passed. Paused and achieved metrics never alert.
      Change them with configure_sla_alerts (reply_warning, reply_critical, wait_warning, wait_critical), or go back to the server defaults with reset."
    `);
  });

  it('ignores stored preferences when the server turned them off', () => {
    expect(
      describeEffectiveThresholds(ADMIN, { reply: { warning: 1, critical: 1 } }, false),
    ).toMatchInlineSnapshot(`
      "SLA alert thresholds in force for you:
      - Reply metrics (first_reply_time, next_reply_time): warning 4h, critical 1h — server default
      - Wait and resolution metrics (every other metric): warning 2d, critical 8h — server default
      A running metric turns WARNING when its breach is closer than the warning threshold, CRITICAL when closer than the critical one, and BREACHED once its deadline has passed. Paused and achieved metrics never alert.
      Personal thresholds are turned off on this server (SLA_USER_PREFERENCES=off): the server defaults apply to everyone."
    `);
  });
});
