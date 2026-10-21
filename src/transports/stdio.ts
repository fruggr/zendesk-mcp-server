import type { McpServer, RequestStateCodec, Transport } from '@modelcontextprotocol/server';
import {
  type StdioServerHandle,
  StdioServerTransport,
  serveStdio,
} from '@modelcontextprotocol/server/stdio';
import { STDIO_MAX_MESSAGE_BYTES } from '../constants';
import { createListenFeed, createListenWireObserver, type ListenFeed } from '../utils/listen-feed';
import { type Logger, silentLogger } from '../utils/logger';
import { createRequestStateCodec } from '../utils/request-state';

/** What the stdio transport supplies to each server it builds. */
export interface StdioBuildExtras {
  notifyResourceUpdated: (uri: string) => void;
  requestStateCodec: RequestStateCodec;
  /** The URIs this connection's 2026-07-28 listen streams ask for. */
  listens: Pick<ListenFeed, 'attach'>;
}

export interface StdioTransportOptions {
  /** Serve over this transport instead of the process's stdin/stdout (tests). */
  transport?: Transport;
}

/**
 * `wire`, with its traffic reported to `feed`: `serveStdio` answers
 * `subscriptions/listen` before any server sees it.
 */
const observeListens = (wire: Transport, feed: ListenFeed): Transport => {
  const observer = createListenWireObserver(feed);
  return {
    start: () => wire.start(),
    send: (message, options) => {
      observer.outbound(message);
      return wire.send(message, options);
    },
    close: () => wire.close(),
    setProtocolVersion: (version) => wire.setProtocolVersion?.(version),
    set onmessage(handler: Transport['onmessage']) {
      wire.onmessage =
        handler &&
        ((message, extra) => {
          observer.inbound(message);
          handler(message, extra);
        });
    },
    set onclose(handler: Transport['onclose']) {
      wire.onclose = () => {
        feed.closeAll();
        handler?.();
      };
    },
    set onerror(handler: Transport['onerror']) {
      wire.onerror = handler;
    },
  };
};

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
  const listens = createListenFeed();
  const transport = observeListens(
    options.transport ??
      new StdioServerTransport(undefined, undefined, { maxBufferSize: STDIO_MAX_MESSAGE_BYTES }),
    listens,
  );
  const handle = serveStdio(
    () => {
      // Late-bound: the notifier is handed to the server it notifies through.
      let server: McpServer | undefined;
      server = build({
        requestStateCodec,
        listens,
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
