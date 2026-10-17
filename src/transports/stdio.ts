import type { McpServer, RequestStateCodec, Transport } from '@modelcontextprotocol/server';
import {
  type StdioServerHandle,
  StdioServerTransport,
  serveStdio,
} from '@modelcontextprotocol/server/stdio';
import { STDIO_MAX_MESSAGE_BYTES } from '../constants';
import { type Logger, silentLogger } from '../utils/logger';
import { createRequestStateCodec } from '../utils/request-state';

/** What the stdio transport supplies to each server it builds. */
export interface StdioBuildExtras {
  notifyResourceUpdated: (uri: string) => void;
  requestStateCodec: RequestStateCodec;
}

export interface StdioTransportOptions {
  /** Serve over this transport instead of the process's stdin/stdout (tests). */
  transport?: Transport;
}

/**
 * Serve MCP over stdio, both protocol eras: the SDK entry picks the era from the
 * client's opening exchange and pins one server from `build` per connection (a
 * `server/discover` probe that falls back to `initialize` builds one more, then
 * drops it).
 */
export const startStdioTransport = (
  build: (extras: StdioBuildExtras) => McpServer,
  logger: Logger = silentLogger,
  options: StdioTransportOptions = {},
): StdioServerHandle => {
  // One process serves every round of a multi-round-trip call: a random key
  // shared by every server of the process is enough.
  const requestStateCodec = createRequestStateCodec({});
  // stdin/stdout are passed as undefined to keep the SDK's defaults (process
  // streams) while reaching the third argument, where our own ceiling replaces the
  // SDK default so the guards and the transport derive from one number. Passing
  // null instead of undefined would override those defaults and break the server.
  const transport =
    options.transport ??
    new StdioServerTransport(undefined, undefined, { maxBufferSize: STDIO_MAX_MESSAGE_BYTES });
  const handle = serveStdio(
    () => {
      // Late-bound: the notifier is handed to the server it notifies through.
      let server: McpServer | undefined;
      server = build({
        requestStateCodec,
        notifyResourceUpdated: (uri) => {
          // On a 2026 connection the SDK routes this to the open listen streams.
          void server?.server.sendResourceUpdated({ uri }).catch(() => undefined);
        },
      });
      return server;
    },
    {
      transport,
      onerror: (error) => logger.warn('stdio_transport_error', { error: error.message }),
    },
  );
  logger.info('stdio_transport_ready');
  return handle;
};
