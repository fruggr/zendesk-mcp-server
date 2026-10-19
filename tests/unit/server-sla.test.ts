import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config';
import { type CreateMcpServerOptions, createMcpServer, watchGrantAlerts } from '../../src/server';
import { createListenFeed } from '../../src/utils/listen-feed';
import type { Logger } from '../../src/utils/logger';
import { signInRequiredError } from '../../src/utils/sign-in-required';
import { createSlaRuntime } from '../../src/utils/sla-service';
import { makeConfig } from '../integration/harness';
import { mswServer } from '../setup';

const SEARCH = 'https://testsubdomain.zendesk.com/api/v2/search';

const recordingLogger = () => {
  const events: string[] = [];
  const log =
    (level: string) =>
    (event: string): void => {
      events.push(`${level}:${event}`);
    };
  const logger: Logger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
  return { logger, events };
};

const connect = async (
  config: Config,
  {
    getToken = () => 'test-token',
    onUnauthorized,
    logger,
    options = {},
  }: {
    getToken?: () => string | Promise<string>;
    onUnauthorized?: () => void;
    logger?: Logger;
    options?: CreateMcpServerOptions;
  } = {},
) => {
  const server = createMcpServer(config, getToken, logger, onUnauthorized, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'server-sla-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

const slaTemplates = async (client: Client) =>
  (await client.listResourceTemplates()).resourceTemplates.filter((t) =>
    t.uriTemplate.startsWith('zendesk-sla:'),
  );

afterEach(() => {
  vi.useRealTimers();
});

describe('SLA alert resources', () => {
  it('invites a subscription only where the push is on', async () => {
    const on = await connect(makeConfig({ mode: 'all', slaPush: true }));
    const off = await connect(makeConfig({ mode: 'all', slaPush: false }));
    try {
      const withPush = await slaTemplates(on.client);
      const withoutPush = await slaTemplates(off.client);
      expect(withPush).toHaveLength(3);
      for (const template of withPush) {
        expect(template.description).toContain(
          'the same report as list_sla_alerts. Subscribe to be told when the set of alerts changes.',
        );
      }
      expect(withoutPush).toHaveLength(3);
      for (const template of withoutPush) {
        expect(template.description).toContain('the same report as list_sla_alerts. {');
        expect(template.description).not.toContain('Subscribe');
      }
    } finally {
      await on.close();
      await off.close();
    }
  });

  it('are left out, polling included, when --tool drops list_sla_alerts', async () => {
    const session = await connect(
      makeConfig({ mode: 'all', slaPush: true, tools: ['get_ticket'] }),
    );
    try {
      expect(await slaTemplates(session.client)).toEqual([]);
      expect(session.client.getServerCapabilities()?.resources?.subscribe).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('report a Zendesk 401 on read, so the dead token is dropped', async () => {
    mswServer.use(http.get(SEARCH, () => new HttpResponse('unauthorized', { status: 401 })));
    const onUnauthorized = vi.fn();
    const session = await connect(makeConfig({ mode: 'all', slaPush: true }), { onUnauthorized });
    try {
      await expect(
        session.client.readResource({ uri: 'zendesk-sla://alerts/mine' }),
      ).rejects.toThrow();
      expect(onUnauthorized).toHaveBeenCalledOnce();
    } finally {
      await session.close();
    }
  });
});

describe('personal thresholds', () => {
  const alertsText = async (config: Config): Promise<string> => {
    const session = await connect(config);
    try {
      const result = await session.client.callTool({
        name: 'list_sla_alerts',
        arguments: { scope: 'mine' },
      });
      return (result.content as Array<{ text?: string }>).map((block) => block.text).join('\n');
    } finally {
      await session.close();
    }
  };

  it('are offered only where configure_sla_alerts is exposed', async () => {
    expect(await alertsText(makeConfig({ mode: 'all', slaPush: true }))).toContain(
      'configure_sla_alerts',
    );
    expect(
      await alertsText(makeConfig({ mode: 'all', slaPush: true, namespaces: ['tickets'] })),
    ).not.toContain('configure_sla_alerts');
  });
});

describe('SLA alert polling', () => {
  it('polls with the background token, never the prompting one, and waits for a sign-in', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const getToken = vi.fn(() => 'test-token');
    const getBackgroundToken = vi.fn(() => Promise.reject(signInRequiredError()));
    const { logger, events } = recordingLogger();
    const session = await connect(makeConfig({ mode: 'all', slaPush: true, slaPollSeconds: 60 }), {
      getToken,
      logger,
      options: { getBackgroundToken },
    });
    try {
      await session.client.subscribeResource({ uri: 'zendesk-sla://alerts/mine' });
      await vi.waitFor(() => expect(events).toContain('debug:sla_alerts_poll_skipped'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getBackgroundToken.mock.calls.length).toBeGreaterThan(1);
      expect(getToken).not.toHaveBeenCalled();
      expect(events.filter((event) => event.startsWith('warn:'))).toEqual([]);
    } finally {
      await session.close();
    }
  });

  it('warns on any other failed poll, and reports a 401 so the dead token is dropped', async () => {
    mswServer.use(http.get(SEARCH, () => new HttpResponse('unauthorized', { status: 401 })));
    const onUnauthorized = vi.fn();
    const { logger, events } = recordingLogger();
    const session = await connect(makeConfig({ mode: 'all', slaPush: true }), {
      onUnauthorized,
      logger,
    });
    try {
      await session.client.subscribeResource({ uri: 'zendesk-sla://alerts/mine' });
      await vi.waitFor(() => expect(events).toContain('warn:sla_alerts_poll_failed'));
      expect(onUnauthorized).toHaveBeenCalledOnce();
    } finally {
      await session.close();
    }
  });

  it("is the grant's on a per-request server: subscriptions advertised, none served", async () => {
    const session = await connect(makeConfig({ mode: 'all', slaPush: true }), {
      options: { alertPolling: 'grant' },
    });
    try {
      expect(session.client.getServerCapabilities()?.resources?.subscribe).toBe(true);
      await expect(
        session.client.subscribeResource({ uri: 'zendesk-sla://alerts/mine' }),
      ).rejects.toThrow();
    } finally {
      await session.close();
    }
  });
});

describe('watchGrantAlerts', () => {
  const grantWatch = (config: Config, onUnauthorized = vi.fn()) => {
    const listens = createListenFeed();
    const notify = vi.fn();
    const { logger, events } = recordingLogger();
    const stop = watchGrantAlerts({
      config,
      getToken: () => 'test-token',
      caches: {
        resolveBrandSubdomain: async () => 'testsubdomain',
        resolveUserId: async () => 1,
        topology: undefined,
        articles: undefined,
      },
      slaRuntime: createSlaRuntime(config),
      logger,
      listens,
      notify,
      onUnauthorized,
    });
    return { listens, stop, events, onUnauthorized };
  };

  it('reports a 401 met while polling a listened URI', async () => {
    mswServer.use(http.get(SEARCH, () => new HttpResponse('unauthorized', { status: 401 })));
    const watch = grantWatch(makeConfig({ mode: 'all', slaPush: true }));
    try {
      watch.listens.open('l1', ['zendesk-sla://alerts/mine']);
      await vi.waitFor(() => expect(watch.events).toContain('warn:sla_alerts_poll_failed'));
      expect(watch.onUnauthorized).toHaveBeenCalledOnce();
    } finally {
      watch.stop();
    }
  });

  it('polls nothing when --tool drops list_sla_alerts', async () => {
    let searches = 0;
    mswServer.use(
      http.get(SEARCH, () => {
        searches += 1;
        return HttpResponse.json({ results: [], count: 0 });
      }),
    );
    const watch = grantWatch(makeConfig({ mode: 'all', slaPush: true, tools: ['get_ticket'] }));
    try {
      watch.listens.open('l1', ['zendesk-sla://alerts/mine']);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(searches).toBe(0);
    } finally {
      watch.stop();
    }
  });
});
