import { acceptedContent, inputRequired, type McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  defaultServerFactory,
  type ServerBuildContext,
  type ServerFactory,
} from '../../src/server';
import { silentLogger } from '../../src/utils/logger';
import type { StdioTestFactory } from './stdio-harness';

export const PING_URI = 'test://ping';

const colorAnswer = z.object({ color: z.string() });

/**
 * The production server plus test-only surface that nothing on `main` exposes
 * yet: a subscribable resource, a tool announcing its change through the
 * transport's notifier, and a multi-round-trip tool. Exercises the transports'
 * notification and `input_required` plumbing in both eras.
 */
const withFixture = (
  server: McpServer,
  {
    notifyResourceUpdated,
    requestStateCodec,
  }: Pick<ServerBuildContext, 'notifyResourceUpdated' | 'requestStateCodec'>,
): McpServer => {
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.registerResource('ping', PING_URI, { mimeType: 'text/plain' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'pong' }],
  }));
  server.registerTool(
    'touch',
    { description: 'Test only.', inputSchema: z.object({}) },
    async () => {
      notifyResourceUpdated(PING_URI);
      return { content: [{ type: 'text', text: 'touched' }] };
    },
  );
  server.registerTool(
    'ask',
    {
      description: 'Test only.',
      inputSchema: z.object({ withState: z.boolean().default(false) }),
    },
    async ({ withState }, ctx) => {
      const answer = acceptedContent(ctx.mcpReq.inputResponses, 'color', colorAnswer);
      if (answer) {
        const state = withState ? ctx.mcpReq.requestState() : undefined;
        return {
          content: [{ type: 'text', text: `color=${answer.color} state=${JSON.stringify(state)}` }],
        };
      }
      return inputRequired({
        inputRequests: {
          color: inputRequired.elicit({ message: 'Which color?', requestedSchema: colorAnswer }),
        },
        ...(withState ? { requestState: await requestStateCodec.mint({ step: 1 }, ctx) } : {}),
      });
    },
  );
  return server;
};

export const fixtureServerFactory: ServerFactory = (ctx) =>
  withFixture(defaultServerFactory(ctx), ctx);

export const fixtureStdioFactory: StdioTestFactory = (config, extras) =>
  fixtureServerFactory({ config, getToken: () => 'test-token', logger: silentLogger, ...extras });
