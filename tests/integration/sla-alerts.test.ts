import { Client, type ElicitResult, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config';
import { createMcpServer } from '../../src/server';
import { makeConfig } from './harness';

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

// A client over the in-memory pipe, optionally able to answer forms with
// `answer`; every form it is shown is recorded.
const connect = async (config: Config, answer?: Answer) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(config, () => 'test-token');
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'sla-alerts-test', version: '0.0.0' },
    answer ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  const forms: Array<{ message: string; requestedSchema: { properties: object } }> = [];
  if (answer) {
    client.setRequestHandler('elicitation/create', (request) => {
      forms.push(request.params as (typeof forms)[number]);
      return Promise.resolve(answer);
    });
  }
  await client.connect(clientTransport);
  return {
    client,
    forms,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

const call = (client: Client, args: Record<string, unknown>) =>
  client.callTool({ name: 'list_sla_alerts', arguments: args });

describe('list_sla_alerts over the wire', () => {
  it('asks a form-capable client for the scope, then answers for the picked one', async () => {
    const session = await connect(makeConfig({ mode: 'all' }), {
      action: 'accept',
      content: { scope: 'all', reply_thresholds: '4h,1h', wait_thresholds: '2d,8h' },
    });
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
    const session = await connect(makeConfig({ mode: 'namespace' }), {
      action: 'accept',
      content: { scope: 'mine' },
    });
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
    const session = await connect(makeConfig({ mode: 'all' }), { action: 'decline' });
    try {
      const text = textOf(await call(session.client, {}));
      expect(text).toContain('No scope was given, so this checks your assigned tickets');
      expect(session.forms).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it('never asks a client without form support: it defaults and explains instead', async () => {
    const session = await connect(makeConfig({ mode: 'all' }));
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
