import {
  Client,
  type ClientOptions,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { defaultServerFactory, type ServerFactory } from '../../src/server';
import { type HttpTransportOptions, startHttpTransport } from '../../src/transports/http';
import { startStdioTransport } from '../../src/transports/stdio';
import {
  createZendeskOAuthMock,
  errorHandlers,
  localServerPassthrough,
  MOCK_LOCALES,
  MOCK_USER,
} from '../msw-handlers';
import { mswServer } from '../setup';
import { fixtureServerFactory, fixtureStdioFactory, PING_URI } from './fixture-server';
import {
  type ConnectedClient,
  clientOptionsFor,
  type Era,
  type IntegrationHarness,
  makeConfig,
} from './harness';
import { createHttpHarness } from './http-harness';
import { signInWithDcr } from './oauth-client';
import { createStdioHarness } from './stdio-harness';

const HC_BASE = 'https://testsubdomain.zendesk.com/api/v2/help_center';
const ZENDESK_BASE = 'https://testsubdomain.zendesk.com/api/v2';

/** Text of a tool call result, joined. */
const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as Array<{ type: string; text?: string }>)
    .map((block) => block.text ?? '')
    .join('\n');

// A client that declares form elicitation and answers every form with a color.
const elicitingClient: ClientOptions = { capabilities: { elicitation: { form: {} } } };
const answerForms = (client: Client): void => {
  client.setRequestHandler('elicitation/create', async () => ({
    action: 'accept',
    content: { color: 'blue' },
  }));
};

/** Resolves on the next `resources/updated` for `uri`, or rejects after `ms`. */
const nextUpdate = (client: Client, uri: string, ms = 2_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no resources/updated for ${uri}`)), ms);
    client.setNotificationHandler('notifications/resources/updated', (notification) => {
      if (notification.params.uri !== uri) return;
      clearTimeout(timer);
      resolve();
    });
  });

const harnesses: Record<Era, IntegrationHarness>[] = [
  {
    '2025': createStdioHarness('2025', fixtureStdioFactory),
    '2026': createStdioHarness('2026', fixtureStdioFactory),
  },
  {
    '2025': createHttpHarness('2025', fixtureServerFactory),
    '2026': createHttpHarness('2026', fixtureServerFactory),
  },
];

for (const byEra of harnesses) {
  describe(`[${byEra['2025'].name}] protocol-era plumbing`, () => {
    let connected: ConnectedClient | undefined;

    afterEach(async () => {
      await connected?.close();
      connected = undefined;
    });

    it('delivers a resource update to a 2026 subscriptions/listen stream', async () => {
      connected = await byEra['2026'].connect(makeConfig());
      const { client } = connected;
      const subscription = await client.listen({ resourceSubscriptions: [PING_URI] });
      const updated = nextUpdate(client, PING_URI);

      await client.callTool({ name: 'touch', arguments: {} });

      await expect(updated).resolves.toBeUndefined();
      await subscription.close();
    });

    for (const era of ['2026', '2025'] as const) {
      it(`completes an input_required round trip for a ${era} client`, async () => {
        connected = await byEra[era].connect(makeConfig(), elicitingClient);
        answerForms(connected.client);

        const result = await connected.client.callTool({ name: 'ask', arguments: {} });

        expect(textOf(result)).toBe('color=blue state=undefined');
      });

      it(`hands the verified requestState back for a ${era} client`, async () => {
        connected = await byEra[era].connect(makeConfig(), elicitingClient);
        answerForms(connected.client);

        const result = await connected.client.callTool({
          name: 'ask',
          arguments: { withState: true },
        });

        expect(textOf(result)).toBe('color=blue state={"step":1}');
      });
    }
  });
}

// Several grants on one HTTP server: each `signInWithDcr` registers a client and
// signs in, so it opens a grant of its own (same Zendesk user).
describe('[http-2026] grant entries', () => {
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });

  const startServer = async (options: HttpTransportOptions = {}, config = makeConfig()) => {
    mswServer.use(localServerPassthrough, ...createZendeskOAuthMock().handlers);
    const handle = await startHttpTransport(
      {
        ...config,
        transport: 'http',
        oauthStore: 'memory://',
        oauthMasterSecret: Buffer.alloc(32, 8).toString('base64'),
      },
      undefined,
      { serverFactory: fixtureServerFactory, ...options },
    );
    closers.push(() => handle.close());
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const grant = async (): Promise<Client> => {
      const { tokens } = await signInWithDcr(baseUrl);
      const client = new Client({ name: 'grant-test', version: '0.0.0' }, clientOptionsFor('2026'));
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${tokens.body.access_token}` } },
        }),
      );
      closers.push(() => client.close());
      return client;
    };
    return { grant };
  };

  it("keeps one grant's notifications away from another grant's listen stream", async () => {
    const { grant } = await startServer();
    const a = await grant();
    const b = await grant();
    await a.listen({ resourceSubscriptions: [PING_URI] });
    let receivedByA = 0;
    a.setNotificationHandler('notifications/resources/updated', () => {
      receivedByA += 1;
    });
    await b.listen({ resourceSubscriptions: [PING_URI] });
    const updatedB = nextUpdate(b, PING_URI);

    await b.callTool({ name: 'touch', arguments: {} });
    await updatedB;
    // A round trip on A after B's update: anything for A would have arrived.
    await a.listTools();

    expect(receivedByA).toBe(0);
  });

  it("closes a grant's listen stream when Zendesk revokes it, and only that grant's", async () => {
    const { grant } = await startServer();
    const a = await grant();
    const b = await grant();
    const listenA = await a.listen({ resourceSubscriptions: [PING_URI] });
    await b.listen({ resourceSubscriptions: [PING_URI] });

    mswServer.use(errorHandlers.usersMeUnauthorized);
    const result = await a.callTool({ name: 'get_current_user', arguments: {} });

    // The call that hit the 401 still answers, as a tool error…
    expect(result.isError).toBe(true);
    // …then the grant's listen stream ends, and the other grant keeps working.
    await expect(listenA.closed).resolves.toMatch(/graceful|remote/);
    const updatedB = nextUpdate(b, PING_URI);
    await b.callTool({ name: 'touch', arguments: {} });
    await expect(updatedB).resolves.toBeUndefined();
  });

  it('answers every request in flight before closing a revoked grant', async () => {
    const gate = () => {
      let open: () => void = () => undefined;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { open, opened };
    };
    const holdStarted = gate();
    const holdReleased = gate();
    const revokeStarted = gate();
    const revokeReleased = gate();
    const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
    // `hold` answers on its own schedule; `revoke` hits the grant's 401 path, then waits.
    const gatedFactory: ServerFactory = (ctx) => {
      const server = fixtureServerFactory(ctx);
      server.registerTool(
        'hold',
        { description: 'Test only.', inputSchema: z.object({}) },
        async () => {
          holdStarted.open();
          await holdReleased.opened;
          return text('held');
        },
      );
      server.registerTool(
        'revoke',
        { description: 'Test only.', inputSchema: z.object({}) },
        async () => {
          ctx.onUnauthorized?.();
          revokeStarted.open();
          await revokeReleased.opened;
          return text('revoked');
        },
      );
      return server;
    };
    const { grant } = await startServer({ serverFactory: gatedFactory });
    const a = await grant();

    const held = a.callTool({ name: 'hold', arguments: {} });
    await holdStarted.opened;
    const revoked = a.callTool({ name: 'revoke', arguments: {} });
    await revokeStarted.opened;
    // The other request answers first, after the grant was revoked…
    holdReleased.open();
    await expect(held).resolves.toMatchObject(text('held'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    revokeReleased.open();

    // …and the request that hit the 401 still gets its own answer.
    await expect(revoked).resolves.toMatchObject(text('revoked'));
  });

  it('closes the listen stream of a grant idle past the timeout', async () => {
    const { grant } = await startServer({ sessionIdleTimeoutMs: 50, sweepIntervalMs: 20 });
    const a = await grant();
    const listenA = await a.listen({ resourceSubscriptions: [PING_URI] });

    await expect(listenA.closed).resolves.toMatch(/graceful|remote/);
  });

  it("hands every request the transport's tool definitions, and each grant its own token", async () => {
    const seen: { tools: unknown; getToken: unknown }[] = [];
    const recording: ServerFactory = (ctx) => {
      seen.push({ tools: ctx.tools, getToken: ctx.getToken });
      return fixtureServerFactory(ctx);
    };
    const { grant } = await startServer({ serverFactory: recording });

    const a = await grant();
    await a.listTools();
    await a.listTools();
    const ofA = seen.splice(0);
    const b = await grant();
    await b.listTools();

    expect(ofA.length).toBeGreaterThanOrEqual(2);
    expect(ofA[0]?.tools).toBeInstanceOf(Array);
    expect(new Set([...ofA, ...seen].map((s) => s.tools)).size).toBe(1);
    expect(new Set(ofA.map((s) => s.getToken)).size).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.map((s) => s.getToken)).not.toContain(ofA[0]?.getToken);
  });

  // The definitions are shared by every grant: only the caller a call carries
  // decides whose token it runs with. Interleaved calls must never cross.
  // `namespace` (the default) reaches the handler through a proxy, a separate
  // dispatch path with its own per-toolset surface.
  it.each([
    { mode: 'all' as const, call: { name: 'get_current_user', arguments: {} } },
    {
      mode: 'namespace' as const,
      call: { name: 'zendesk_users', arguments: { operation: 'get_current_user', params: {} } },
    },
  ])(
    "runs each grant's calls with its own Zendesk token, interleaved ($mode)",
    async ({ mode, call }) => {
      const { grant } = await startServer(
        { serverFactory: defaultServerFactory },
        makeConfig({ mode }),
      );
      const a = await grant();
      const b = await grant();
      mswServer.use(
        http.get(`${ZENDESK_BASE}/users/me`, ({ request }) => {
          const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
          return HttpResponse.json({ user: { ...MOCK_USER, name: `Owner of ${token}` } });
        }),
      );
      const whoAmI = async (client: Client) => textOf(await client.callTool(call));

      const [a1, b1, a2, b2] = await Promise.all([whoAmI(a), whoAmI(b), whoAmI(a), whoAmI(b)]);

      const ownerA = a1.match(/Owner of (\S+)/)?.[1];
      const ownerB = b1.match(/Owner of (\S+)/)?.[1];
      expect(ownerA).toMatch(/^zd-access-/);
      expect(ownerB).toMatch(/^zd-access-/);
      expect(ownerA).not.toBe(ownerB);
      expect(a2).toContain(`Owner of ${ownerA}`);
      expect(b2).toContain(`Owner of ${ownerB}`);
    },
  );

  it('fetches the Help Center topology once per grant within its cache lifetime', async () => {
    let localesCalls = 0;
    mswServer.use(
      http.get(`${HC_BASE}/locales`, () => {
        localesCalls += 1;
        return HttpResponse.json(MOCK_LOCALES);
      }),
    );
    const { grant } = await startServer();
    const a = await grant();
    const b = await grant();

    await a.readResource({ uri: 'zendesk-hc://topology' });
    await a.readResource({ uri: 'zendesk-hc://topology' });
    expect(localesCalls).toBe(1);

    await b.readResource({ uri: 'zendesk-hc://topology' });
    expect(localesCalls).toBe(2);
  });
});

describe('[stdio-2026] requestState integrity', () => {
  it('refuses a requestState the client altered', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = startStdioTransport(
      (extras) => fixtureStdioFactory(makeConfig(), extras),
      undefined,
      {
        transport: serverTransport,
      },
    );
    // A client that tampers with the opaque state when it retries the call.
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => {
      const params = 'params' in message ? (message.params as Record<string, unknown>) : undefined;
      const forged =
        params && typeof params['requestState'] === 'string'
          ? { ...message, params: { ...params, requestState: `${params['requestState']}x` } }
          : message;
      return send(forged as typeof message, options);
    };
    const client = new Client(
      { name: 'tamper-test', version: '0.0.0' },
      { ...clientOptionsFor('2026'), ...elicitingClient },
    );
    answerForms(client);
    await client.connect(clientTransport);
    try {
      await expect(
        client.callTool({ name: 'ask', arguments: { withState: true } }),
      ).rejects.toThrow('Invalid or expired requestState');
    } finally {
      await client.close();
      await handle.close();
    }
  });
});
