import type { Client, ElicitResult } from '@modelcontextprotocol/client';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config';
import { MOCK_SLA_SIDELOAD, MOCK_TICKET } from '../msw-handlers';
import { mswServer } from '../setup';
import { type Era, makeConfig } from './harness';
import { createStdioHarness } from './stdio-harness';

// The mocked running metric breaches at 2099-06-18T21:37:00Z: 97 minutes after
// this clock, CRITICAL under the default thresholds.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2099-06-18T20:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

const textOf = (result: { content?: unknown }): string =>
  ((result.content ?? []) as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? '')
    .join('\n');

type Answer = ElicitResult;

// A stdio client in `era`, optionally able to answer forms with `answer`;
// every form it is shown is recorded. A 2026 client gets them as
// `input_required` rounds, a 2025 one as `elicitation/create` requests.
const connect = async (config: Config, answer?: Answer, era: Era = '2025') => {
  const { client, close } = await createStdioHarness(era).connect(
    config,
    answer ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  const forms: Array<{ message: string; requestedSchema: { properties: object } }> = [];
  if (answer) {
    client.setRequestHandler('elicitation/create', (request) => {
      forms.push(request.params as (typeof forms)[number]);
      return Promise.resolve(answer);
    });
  }
  return { client, forms, close };
};

const call = (client: Client, args: Record<string, unknown>) =>
  client.callTool({ name: 'list_sla_alerts', arguments: args });

for (const era of ['2025', '2026'] as const) {
  describe(`list_sla_alerts over the wire (${era})`, () => {
    it('asks a form-capable client for the scope, then answers for the picked one', async () => {
      const session = await connect(
        makeConfig({ mode: 'all' }),
        {
          action: 'accept',
          content: { scope: 'all', reply_thresholds: '4h,1h', wait_thresholds: '2d,8h' },
        },
        era,
      );
      try {
        const result = await call(session.client, {});
        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain(
          'SLA alerts for all unsolved tickets: 0 breached, 1 critical',
        );
        expect(session.forms).toHaveLength(1);
        expect(Object.keys(session.forms[0]?.requestedSchema.properties ?? {})).toEqual([
          'scope',
          'reply_thresholds',
          'wait_thresholds',
        ]);
        // Introduced once: the next call names its scope and is not asked anything.
        await call(session.client, { scope: 'mine' });
        expect(session.forms).toHaveLength(1);
      } finally {
        await session.close();
      }
    });

    it('works through the tickets proxy too', async () => {
      const session = await connect(
        makeConfig({ mode: 'namespace' }),
        {
          action: 'accept',
          content: { scope: 'mine' },
        },
        era,
      );
      try {
        const result = await session.client.callTool({
          name: 'zendesk_tickets',
          arguments: { operation: 'list_sla_alerts', params: {} },
        });
        expect(textOf(result)).toContain('SLA alerts for your assigned unsolved tickets');
        expect(session.forms).toHaveLength(1);
      } finally {
        await session.close();
      }
    });

    it('defaults to "mine" when the user declines the form', async () => {
      const session = await connect(makeConfig({ mode: 'all' }), { action: 'decline' }, era);
      try {
        const text = textOf(await call(session.client, {}));
        expect(text).toContain('No scope was given, so this checks your assigned tickets');
        expect(session.forms).toHaveLength(1);
      } finally {
        await session.close();
      }
    });

    it('never asks a client without form support: it defaults and explains instead', async () => {
      const session = await connect(makeConfig({ mode: 'all' }), undefined, era);
      try {
        const text = textOf(await call(session.client, {}));
        expect(text).toContain(
          'No scope was given, so this checks your assigned tickets (scope "mine")',
        );
        expect(text).toContain('SLA alert thresholds in force for you:');
      } finally {
        await session.close();
      }
    });
  });
}

describe('SLA alert resources', () => {
  it('lists the three named alert sets and reads one as the tool would render it', async () => {
    const session = await connect(makeConfig({ mode: 'namespace' }));
    try {
      const { resources } = await session.client.listResources();
      expect(resources.filter((r) => r.uri.startsWith('zendesk-sla:')).map((r) => r.uri)).toEqual([
        'zendesk-sla://alerts/mine',
        'zendesk-sla://alerts/my_groups',
        'zendesk-sla://alerts/all',
      ]);
      const read = await session.client.readResource({ uri: 'zendesk-sla://alerts/all' });
      const [content] = read.contents;
      expect(content && 'text' in content ? content.text : '').toContain(
        'SLA alerts for all unsolved tickets: 0 breached, 1 critical',
      );
      const view = await session.client.readResource({ uri: 'zendesk-sla://alerts/views/25' });
      expect(JSON.stringify(view.contents)).toContain('SLA alerts for view 25');
      const query = await session.client.readResource({
        uri: 'zendesk-sla://alerts?query=priority%3Aurgent',
      });
      expect(JSON.stringify(query.contents)).toContain(
        'the tickets matching \\"priority:urgent\\"',
      );
    } finally {
      await session.close();
    }
  });

  it('can be read without --sla-push, but not subscribed to', async () => {
    const session = await connect(makeConfig({ mode: 'namespace', slaPush: false }));
    try {
      expect(session.client.getServerCapabilities()?.resources?.subscribe).toBeFalsy();
      const read = await session.client.readResource({ uri: 'zendesk-sla://alerts/mine' });
      expect(JSON.stringify(read.contents)).toContain('SLA alerts for your assigned');
      await expect(
        session.client.subscribeResource({ uri: 'zendesk-sla://alerts/mine' }),
      ).rejects.toThrow();
    } finally {
      await session.close();
    }
  });
});

describe('SLA alert subscriptions', () => {
  // The poll timer is faked too; the in-memory pipe and MSW keep their real
  // setTimeout, so only polling moves with the clock.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2099-06-18T20:00:00Z'));
  });

  // Search answers with the metric breaching at `breachAt`.
  const searchBreachingAt = (breachAt: string) =>
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/search', () =>
        HttpResponse.json({
          results: [
            {
              ...MOCK_TICKET,
              slas: {
                policy_metrics: [
                  { metric: 'requester_wait_time', stage: 'active', breach_at: breachAt },
                ],
              },
            },
          ],
          count: 1,
        }),
      ),
    );

  const subscribedSession = async (slaPollSeconds = 60) => {
    const session = await connect(makeConfig({ mode: 'namespace', slaPollSeconds, slaPush: true }));
    const updates: string[] = [];
    session.client.setNotificationHandler('notifications/resources/updated', (notification) => {
      updates.push(notification.params.uri);
    });
    return { ...session, updates };
  };

  it('advertises subscriptions and notifies only when the alert set changes', async () => {
    searchBreachingAt(MOCK_SLA_SIDELOAD.policy_metrics[1]?.breach_at ?? '');
    const session = await subscribedSession();
    try {
      expect(session.client.getServerCapabilities()?.resources?.subscribe).toBe(true);
      await session.client.subscribeResource({ uri: 'zendesk-sla://alerts/all' });
      // Same alert, minutes counting down: no notification.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(session.updates).toEqual([]);
      // CRITICAL turns BREACHED: one notification.
      searchBreachingAt('2099-06-18T19:00:00Z');
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(session.updates).toEqual(['zendesk-sla://alerts/all']));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(session.updates).toEqual(['zendesk-sla://alerts/all']);
    } finally {
      await session.close();
    }
  });

  it('polls every SLA_POLL_SECONDS, not sooner', async () => {
    let searches = 0;
    mswServer.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname.endsWith('/search')) searches += 1;
    });
    const session = await subscribedSession(120);
    try {
      await session.client.subscribeResource({ uri: 'zendesk-sla://alerts/mine' });
      await vi.waitFor(() => expect(searches).toBe(1));
      await vi.advanceTimersByTimeAsync(119_000);
      expect(searches).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(searches).toBe(2));
    } finally {
      mswServer.events.removeAllListeners();
      await session.close();
    }
  });

  it('stops notifying after unsubscribe, and stops polling with the session', async () => {
    searchBreachingAt('2099-06-18T21:00:00Z');
    const session = await subscribedSession();
    try {
      await session.client.subscribeResource({ uri: 'zendesk-sla://alerts/all' });
      await session.client.unsubscribeResource({ uri: 'zendesk-sla://alerts/all' });
      searchBreachingAt('2099-06-18T19:00:00Z');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(session.updates).toEqual([]);
      await session.client.subscribeResource({ uri: 'zendesk-sla://alerts/mine' });
    } finally {
      await session.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses a subscription to anything but an alert resource', async () => {
    const session = await subscribedSession();
    try {
      await expect(
        session.client.subscribeResource({ uri: 'zendesk-hc://topology' }),
      ).rejects.toThrow('Only SLA alert resources');
    } finally {
      await session.close();
    }
  });
});

const SCOPE_QUERY = {
  mine: 'type:ticket assignee:me status<solved',
  all: 'type:ticket status<solved',
};

describe('SLA alert listen streams (2026)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2099-06-18T20:00:00Z'));
  });

  const searchBreachingAt = (breachAt: string) =>
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/search', () =>
        HttpResponse.json({
          results: [
            {
              ...MOCK_TICKET,
              slas: {
                policy_metrics: [
                  { metric: 'requester_wait_time', stage: 'active', breach_at: breachAt },
                ],
              },
            },
          ],
          count: 1,
        }),
      ),
    );

  // Counts only the searches of `scope`: a previous test's request still in
  // flight may land in this one.
  const listeningSession = async (scope: 'mine' | 'all', slaPush = true) => {
    const session = await connect(
      makeConfig({ mode: 'namespace', slaPollSeconds: 60, slaCacheTtlSeconds: 30, slaPush }),
      undefined,
      '2026',
    );
    const updates: string[] = [];
    session.client.setNotificationHandler('notifications/resources/updated', (notification) => {
      updates.push(notification.params.uri);
    });
    let searches = 0;
    mswServer.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (
        url.pathname.endsWith('/search') &&
        url.searchParams.get('query') === SCOPE_QUERY[scope]
      ) {
        searches += 1;
      }
    });
    return {
      ...session,
      updates,
      searches: () => searches,
      close: async () => {
        mswServer.events.removeAllListeners();
        await session.close();
      },
    };
  };

  it('notifies a listened alert resource only when its alert set changes', async () => {
    searchBreachingAt('2099-06-18T21:37:00Z');
    const session = await listeningSession('all');
    try {
      const listen = await session.client.listen({
        resourceSubscriptions: ['zendesk-sla://alerts/all', 'zendesk-hc://topology'],
      });
      expect(listen.honoredFilter.resourceSubscriptions).toEqual([
        'zendesk-sla://alerts/all',
        'zendesk-hc://topology',
      ]);
      // Same alert, minutes counting down: no notification.
      await vi.waitFor(() => expect(session.searches()).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(session.updates).toEqual([]);
      searchBreachingAt('2099-06-18T19:00:00Z');
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(session.updates).toEqual(['zendesk-sla://alerts/all']));
    } finally {
      await session.close();
    }
  });

  it('keeps polling while one stream still listens, and stops with the last one', async () => {
    const session = await listeningSession('mine');
    try {
      const first = await session.client.listen({
        resourceSubscriptions: ['zendesk-sla://alerts/mine'],
      });
      const second = await session.client.listen({
        resourceSubscriptions: ['zendesk-sla://alerts/mine'],
      });
      await vi.waitFor(() => expect(session.searches()).toBe(1));
      await first.close();
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(session.searches()).toBe(2));
      await second.close();
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(session.searches()).toBe(2);
    } finally {
      await session.close();
    }
  });

  it('stops polling with the connection', async () => {
    const session = await listeningSession('mine');
    await session.client.listen({ resourceSubscriptions: ['zendesk-sla://alerts/mine'] });
    await vi.waitFor(() => expect(session.searches()).toBe(1));
    await session.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors no alert subscription without --sla-push', async () => {
    const session = await listeningSession('mine', false);
    try {
      const listen = await session.client.listen({
        resourceSubscriptions: ['zendesk-sla://alerts/mine'],
      });
      expect(listen.honoredFilter.resourceSubscriptions).toBeUndefined();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(session.searches()).toBe(0);
    } finally {
      await session.close();
    }
  });
});
