import { describe, expect, it } from 'vitest';
import { thresholdsSource } from '../../../src/utils/sla-alerts-check';

const allowed = { userPreferencesAllowed: true };
const pair = { warning: 240, critical: 60 };

describe('thresholdsSource', () => {
  it('names a per-call override first', () => {
    expect(thresholdsSource(allowed, { reply: pair }, true)).toBe('overridden for this call');
  });

  it('names the server default without pointing to a tool when preferences are off', () => {
    expect(thresholdsSource({ userPreferencesAllowed: false }, { reply: pair }, false)).toBe(
      'server default',
    );
  });

  it('names the user as the source when either family is their own', () => {
    const yours = 'yours; change them with configure_sla_alerts';
    expect(thresholdsSource(allowed, { reply: pair }, false)).toBe(yours);
    expect(thresholdsSource(allowed, { wait: pair }, false)).toBe(yours);
  });

  it('points to configure_sla_alerts when the user has none', () => {
    const none = 'server default; set your own with configure_sla_alerts';
    expect(thresholdsSource(allowed, undefined, false)).toBe(none);
    expect(thresholdsSource(allowed, {}, false)).toBe(none);
  });
});
