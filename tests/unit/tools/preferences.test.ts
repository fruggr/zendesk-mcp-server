import { describe, expect, it } from 'vitest';
import { createPreferenceTools } from '../../../src/tools/preferences';
import type { SlaService } from '../../../src/utils/sla-service';
import { testSlaService } from '../../sla-service';
import { testToolContext } from '../../tool-context';
import { firstText } from '../../tool-result';

const configure = (sla: SlaService | undefined) => {
  const [tool] = createPreferenceTools(testToolContext({ sla }));
  if (!tool) throw new Error('configure_sla_alerts missing');
  return (params: Record<string, unknown>) => tool.handler(params).then((r) => firstText(r) ?? '');
};

describe('configure_sla_alerts', () => {
  it('is the only preferences tool', () => {
    expect(createPreferenceTools(testToolContext()).map((t) => t.name)).toEqual([
      'configure_sla_alerts',
    ]);
  });

  it('reports the thresholds in force, and changes nothing, when called with no input', async () => {
    const sla = testSlaService();
    expect(await configure(sla)({})).toMatch(
      /^SLA alert thresholds in force for you:\n- Reply metrics/,
    );
    expect(await sla.preferences()).toBeUndefined();
  });

  it('saves personal thresholds and reports them as the caller’s own', async () => {
    const sla = testSlaService();
    const text = await configure(sla)({ reply_warning: '2h', reply_critical: '30m' });
    expect(text).toMatch(/^Your SLA alert thresholds were saved\.\n\nSLA alert thresholds/);
    expect(text).toContain(
      '- Reply metrics (first_reply_time, next_reply_time): warning 2h, critical 30m — your preference',
    );
    expect(await sla.thresholds()).toMatchObject({ reply: { warning: 120, critical: 30 } });
  });

  it('resets back to the server defaults', async () => {
    const sla = testSlaService();
    await sla.savePreferences({ wait: { warning: 10, critical: 5 } });
    await configure(sla)({ reset: 'all' });
    expect(await sla.preferences()).toEqual({});
  });

  it('refuses an invalid change and saves nothing', async () => {
    const sla = testSlaService();
    await expect(configure(sla)({ wait_critical: '3d' })).rejects.toThrow(
      'The wait critical threshold (3d) must not be longer than its warning one (2d). Nothing was changed.',
    );
    expect(await sla.preferences()).toBeUndefined();
  });

  it('changes nothing when the operator turned preferences off, and says so', async () => {
    const sla = testSlaService({ userPreferencesAllowed: false });
    const text = await configure(sla)({ reply_warning: '2h' });
    expect(text).toMatch(/^Nothing was changed\.\n\nSLA alert thresholds/);
    expect(text).toContain('Personal thresholds are turned off on this server');
    expect(await sla.preferences()).toBeUndefined();
  });

  it('fails plainly where no SLA service is wired', async () => {
    await expect(configure(undefined)({})).rejects.toThrow(
      'SLA alerting is not available on this server.',
    );
  });
});
