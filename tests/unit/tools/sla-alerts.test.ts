import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '../../../src/tools/definitions';
import { createAlertsReader, createSlaAlertTools } from '../../../src/tools/sla-alerts';
import { isInputRequiredError } from '../../../src/utils/elicitation';
import { MAX_ALERT_LINES } from '../../../src/utils/sla-alerts-check';
import type { SlaService } from '../../../src/utils/sla-service';
import { MOCK_TICKET, MOCK_VIEW } from '../../msw-handlers';
import { mswServer } from '../../setup';
import { testSlaService } from '../../sla-service';
import { testToolContext } from '../../tool-context';
import { firstText } from '../../tool-result';

const BASE = 'https://testsubdomain.zendesk.com/api/v2';

// The mocked running metric (requester_wait_time) breaches at
// 2099-06-18T21:37:00Z: 97 minutes after this clock, CRITICAL by default.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2099-06-18T20:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  mswServer.events.removeAllListeners();
});

const tool = (sla: SlaService | undefined = testSlaService()) => {
  const [def] = createSlaAlertTools(testToolContext({ sla }));
  if (!def) throw new Error('list_sla_alerts missing');
  return def;
};

const run = (
  params: Record<string, unknown>,
  sla?: SlaService,
  call?: ToolCallContext,
): Promise<string> =>
  tool(sla)
    .handler({ include_breached: true, ...params }, call)
    .then((r) => firstText(r) ?? '');

// Every Zendesk path the tool calls, query included.
const recordCalls = (): string[] => {
  const calls: string[] = [];
  mswServer.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    calls.push(`${url.pathname.replace('/api/v2', '')}?${url.searchParams.toString()}`);
  });
  return calls;
};

const introduced = () =>
  testSlaService({ preferences: () => Promise.resolve({ introduced: true }) });

describe('list_sla_alerts', () => {
  it('is one read-only tool in the tickets namespace', () => {
    const def = tool();
    expect([def.name, def.namespace, def.readOnly, def.annotations.readOnlyHint]).toEqual([
      'list_sla_alerts',
      'tickets',
      true,
      true,
    ]);
    expect(MAX_ALERT_LINES).toBe(100);
  });

  it('checks the assigned tickets for "mine" and lists the urgent metric', async () => {
    const calls = recordCalls();
    const text = await run({ scope: 'mine' }, introduced());
    expect(calls).toEqual([
      '/search?query=type%3Aticket+assignee%3Ame+status%3Csolved&include=tickets%28slas%29&per_page=100&page=1',
    ]);
    expect(text).toMatchInlineSnapshot(`
      "SLA alerts for your assigned unsolved tickets: 0 breached, 1 critical, 0 warning (1 ticket(s) checked).
      Thresholds: reply metrics warning 4h, critical 1h; wait and resolution metrics warning 2d, critical 8h (server default; set your own with configure_sla_alerts).

      ## CRITICAL
      - #1 requester_wait_time due in 1h37m (due 2099-06-18T21:37:00Z) — "Test ticket" [open, normal]"
    `);
  });

  it('refuses more than one way of choosing the tickets', async () => {
    await expect(run({ scope: 'mine', query: 'x' })).rejects.toThrow(
      'Pass only one of scope, view or query.',
    );
  });

  it('refuses an unreadable within', async () => {
    await expect(run({ scope: 'mine', within: 'soon' })).rejects.toThrow(
      'within: "soon" is not a duration.',
    );
  });

  it('honours within, the per-call overrides and include_breached', async () => {
    const sla = introduced();
    expect(await run({ scope: 'mine', within: '1h' }, sla)).toContain('0 critical');
    expect(await run({ scope: 'mine', within: '2h' }, sla)).toContain('1 critical');
    const overridden = await run({ scope: 'mine', warning: '3h', critical: '1h' }, sla);
    expect(overridden).toContain('0 breached, 0 critical, 1 warning');
    expect(overridden).toContain('(overridden for this call)');
    await expect(run({ scope: 'mine', warning: '2h', critical: '5h' }, sla)).rejects.toThrow(
      'The critical threshold (5h) must not be longer than the warning one (2h).',
    );
    vi.setSystemTime(new Date('2099-06-18T22:00:00Z'));
    expect(await run({ scope: 'all' }, sla)).toContain('1 breached');
    expect(await run({ scope: 'all', include_breached: false }, sla)).toContain('0 breached');
  });

  it('serves a repeated scope from the cache', async () => {
    const calls = recordCalls();
    const sla = introduced();
    await run({ scope: 'all' }, sla);
    await run({ scope: 'all' }, sla);
    expect(calls).toHaveLength(1);
  });

  it('reads a query as given', async () => {
    const calls = recordCalls();
    expect(await run({ query: 'priority:urgent' }, introduced())).toContain(
      'SLA alerts for the tickets matching "priority:urgent"',
    );
    expect(calls[0]).toContain('query=type%3Aticket+priority%3Aurgent');
  });

  it("checks the caller's groups one search per group", async () => {
    const calls = recordCalls();
    const sla = testSlaService({
      preferences: () => Promise.resolve({ introduced: true }),
      userId: () => Promise.resolve(9999),
    });
    expect(await run({ scope: 'my_groups' }, sla)).toContain("your groups' unsolved tickets");
    expect(calls).toEqual([
      '/users/9999/group_memberships?page%5Bsize%5D=100',
      '/search?query=type%3Aticket+group%3A300+status%3Csolved&include=tickets%28slas%29&per_page=100&page=1',
    ]);
  });

  it('reads a view by title through its tickets endpoint', async () => {
    const calls = recordCalls();
    const text = await run({ view: MOCK_VIEW.title }, introduced());
    expect(text).toContain(`SLA alerts for view ${MOCK_VIEW.id}: 0 breached, 1 critical`);
    expect(calls.at(-1)).toBe(`/views/${MOCK_VIEW.id}/tickets?include=slas&per_page=100&page=1`);
  });

  it('lists the available views when the title matches none', async () => {
    expect(await run({ view: 'Nope' }, introduced())).toBe(
      'No active view matches "Nope". Available views: Unassigned tickets.',
    );
    mswServer.use(http.get(`${BASE}/views`, () => HttpResponse.json({ views: [] })));
    expect(await run({ view: 'Nope' }, introduced())).toBe(
      'No active view matches "Nope", and no active views were found for this agent.',
    );
  });

  it('says how many tickets it left unread', async () => {
    mswServer.use(
      http.get(`${BASE}/search`, () =>
        HttpResponse.json({ results: [MOCK_TICKET], count: 900, next_page: 'more' }),
      ),
    );
    expect(await run({ scope: 'all' }, introduced())).toContain(
      'Truncated: 895 more ticket(s) in this scope were not read.',
    );
  });

  it('fails plainly where no SLA service is wired', async () => {
    await expect(
      createSlaAlertTools(testToolContext())[0]?.handler({ scope: 'mine' }),
    ).rejects.toThrow('SLA alerting is not available on this server.');
  });

  describe('with no scope and a client that cannot answer forms', () => {
    it('falls back to "mine" and says so', async () => {
      const text = await run({}, introduced(), { canElicit: false });
      expect(text).toContain('SLA alerts for your assigned unsolved tickets');
      expect(text).toContain(
        'No scope was given, so this checks your assigned tickets (scope "mine"). Pass scope, view or query for another set.',
      );
    });

    it('explains the thresholds on the first call only', async () => {
      const sla = testSlaService();
      const first = await run({ scope: 'mine' }, sla);
      expect(first).toContain('\nSLA alert thresholds in force for you:\n- Reply metrics');
      expect(await sla.preferences()).toEqual({ introduced: true });
      expect(await run({ scope: 'mine' }, sla)).not.toContain('in force for you');
    });

    it('never explains them when the operator turned preferences off', async () => {
      const sla = testSlaService({ userPreferencesAllowed: false });
      const text = await run({ scope: 'mine' }, sla);
      expect(text).not.toContain('in force for you');
      expect(text).toContain('(server default)');
      expect(await sla.preferences()).toBeUndefined();
    });
  });

  describe('with a client that answers forms', () => {
    const elicit = { canElicit: true };

    const askedFor = async (params: Record<string, unknown>, sla: SlaService) => {
      try {
        await run(params, sla, elicit);
      } catch (err) {
        if (isInputRequiredError(err)) return err.inputRequired;
        throw err;
      }
      return undefined;
    };

    it('asks for the scope when none was given', async () => {
      const asked = await askedFor({}, introduced());
      const request = asked?.inputRequests?.['sla_alerts'] as {
        method: string;
        params: { mode: string; message: string; requestedSchema: { required?: string[] } };
      };
      expect(request.method).toBe('elicitation/create');
      expect(request.params.mode).toBe('form');
      expect(request.params.message).toBe('Which tickets should be checked for SLA alerts?');
      expect(request.params.requestedSchema.required).toEqual(['scope']);
    });

    it('asks nothing of an introduced user who named the tickets', async () => {
      expect(await askedFor({ scope: 'mine' }, introduced())).toBeUndefined();
    });

    it('shows a new user the thresholds even with a scope given', async () => {
      const asked = await askedFor({ scope: 'mine' }, testSlaService());
      const request = asked?.inputRequests?.['sla_alerts'] as {
        params: { requestedSchema: { properties: object } };
      };
      expect(Object.keys(request.params.requestedSchema.properties)).toEqual([
        'reply_thresholds',
        'wait_thresholds',
      ]);
    });

    it('uses the picked scope and applies edited thresholds to this call only', async () => {
      const calls = recordCalls();
      const sla = testSlaService();
      const text = await run({}, sla, {
        canElicit: true,
        inputResponses: {
          sla_alerts: {
            action: 'accept',
            content: { scope: 'all', reply_thresholds: '2h,30m', wait_thresholds: '3h,2h' },
          },
        },
      });
      expect(text).toContain('SLA alerts for all unsolved tickets: 0 breached, 1 critical');
      expect(text).toContain(
        'Thresholds: reply metrics warning 2h, critical 30m; wait and resolution metrics warning 3h, critical 2h (overridden for this call).',
      );
      expect(text).toContain(
        'The thresholds you edited apply to this call only. To keep them, call configure_sla_alerts with reply_warning: "2h", reply_critical: "30m", wait_warning: "3h", wait_critical: "2h".',
      );
      expect(calls[0]).toContain('query=type%3Aticket+status%3Csolved&');
      // Only the introduction is remembered: the edits are not stored.
      expect(await sla.preferences()).toEqual({ introduced: true });
    });

    it('lets the per-call overrides win over thresholds edited in the form', async () => {
      const text = await run({ scope: 'mine', warning: '1d', critical: '1h' }, testSlaService(), {
        canElicit: true,
        inputResponses: {
          sla_alerts: { action: 'accept', content: { wait_thresholds: '3h,2h' } },
        },
      });
      expect(text).toContain('wait and resolution metrics warning 1d, critical 1h');
      expect(text).toContain('0 breached, 0 critical, 1 warning');
    });

    it('fails a bad call before any form or write', async () => {
      const sla = testSlaService();
      await expect(run({ critical: 'x' }, sla, elicit)).rejects.toThrow('is not a duration');
      await expect(run({ within: 'soon' }, sla, elicit)).rejects.toThrow('is not a duration');
      await expect(run({ scope: 'mine', query: 'x' }, sla, elicit)).rejects.toThrow(
        'Pass only one of scope, view or query.',
      );
      expect(await run({ view: 'No such view' }, sla, elicit)).toContain(
        'No active view matches "No such view". Available views:',
      );
      expect(await sla.preferences()).toBeUndefined();
    });

    it('says why edited thresholds were not applied, and still answers', async () => {
      const sla = testSlaService();
      const text = await run({ scope: 'mine' }, sla, {
        canElicit: true,
        inputResponses: {
          sla_alerts: { action: 'accept', content: { reply_thresholds: '1h,2h' } },
        },
      });
      expect(text).toContain(
        'Your reply thresholds "1h,2h" were not applied: The critical threshold (2h) must not be longer than the warning one (1h).',
      );
      expect(await sla.preferences()).toEqual({ introduced: true });
    });

    it('falls back to "mine" when the user declines, and does not ask again', async () => {
      const sla = testSlaService();
      const text = await run({}, sla, {
        canElicit: true,
        inputResponses: { sla_alerts: { action: 'decline' } },
      });
      expect(text).toContain('No scope was given, so this checks your assigned tickets');
      expect(text).not.toContain('in force for you');
      expect(await sla.preferences()).toEqual({ introduced: true });
    });
  });
});

describe('createAlertsReader', () => {
  const reader = (sla: SlaService = introduced()) =>
    createAlertsReader({ subdomain: 'testsubdomain', getToken: () => 'token', sla });
  const viewLookups = (calls: string[]) => calls.filter((c) => c.startsWith('/views?')).length;

  it('resolves a view title once per reader, not on every read', async () => {
    const calls = recordCalls();
    const alerts = reader();
    const uri = `zendesk-sla://alerts/views/${encodeURIComponent(MOCK_VIEW.title)}`;
    expect(await alerts.read(uri)).toContain(`SLA alerts for view ${MOCK_VIEW.id}`);
    await alerts.fingerprint(uri);
    expect(viewLookups(calls)).toBe(1);
    // Another reader (connection, session or grant) resolves on its own.
    await reader().read(uri);
    expect(viewLookups(calls)).toBe(2);
  });

  it('still reports, on the default thresholds, when the stored preferences cannot be read', async () => {
    const text = await reader(
      testSlaService({ preferences: () => Promise.reject(new Error('EIO')) }),
    ).read('zendesk-sla://alerts/mine');
    expect(text).toContain('Thresholds: ');
    expect(text).toContain('server default; set your own with configure_sla_alerts');
  });

  it('never looks a numeric view id up', async () => {
    const calls = recordCalls();
    await reader().read(`zendesk-sla://alerts/views/${MOCK_VIEW.id}`);
    expect(viewLookups(calls)).toBe(0);
  });

  it('resolves the title afresh after a failed read of its view', async () => {
    const calls = recordCalls();
    const alerts = reader();
    const uri = `zendesk-sla://alerts/views/${encodeURIComponent(MOCK_VIEW.title)}`;
    mswServer.use(
      http.get(`${BASE}/views/:id/tickets`, () => HttpResponse.json({}, { status: 404 }), {
        once: true,
      }),
    );
    await expect(alerts.read(uri)).rejects.toThrow();
    await alerts.read(uri);
    expect(viewLookups(calls)).toBe(2);
  });

  it('names the views it knows when the title matches none', async () => {
    await expect(reader().read('zendesk-sla://alerts/views/nope')).rejects.toThrow(
      'No active view matches "nope". Available views:',
    );
  });

  it('refuses a URI that is not an alert resource', async () => {
    await expect(reader().read('zendesk-hc://topology')).rejects.toThrow(
      'Not an SLA alert resource: zendesk-hc://topology',
    );
  });
});
