import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STDIO_MAX_MESSAGE_BYTES } from '../../../src/constants';
import { type StdioBuildExtras, startStdioTransport } from '../../../src/transports/stdio';
import type { Logger } from '../../../src/utils/logger';

vi.mock('@modelcontextprotocol/server/stdio', () => ({
  StdioServerTransport: vi.fn(),
  serveStdio: vi.fn(() => ({ close: vi.fn() })),
}));

type ServeOptions = Parameters<typeof serveStdio>[1];
type SdkFactory = Parameters<typeof serveStdio>[0];

const serveCall = (): { factory: SdkFactory; options: ServeOptions } => {
  const [factory, options] = vi.mocked(serveStdio).mock.calls[0] ?? [];
  if (!factory) throw new Error('serveStdio was not called');
  return { factory, options };
};

const fakeServer = () => ({
  server: { sendResourceUpdated: vi.fn().mockResolvedValue(undefined) },
});

describe('startStdioTransport', () => {
  beforeEach(() => {
    vi.mocked(serveStdio).mockClear();
    vi.mocked(StdioServerTransport).mockClear();
  });

  it('serves the SDK stdio entry over a transport carrying our own ceiling', () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer stand-in
    startStdioTransport(() => fakeServer() as any);

    expect(StdioServerTransport).toHaveBeenCalledWith(undefined, undefined, {
      maxBufferSize: STDIO_MAX_MESSAGE_BYTES,
    });
    expect(vi.mocked(StdioServerTransport).mock.instances).toHaveLength(1);
  });

  it('serves over the transport it is given instead, every call passed through', async () => {
    const transport = {
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      setProtocolVersion: vi.fn(),
      onerror: undefined as unknown,
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal stand-ins
    startStdioTransport(() => fakeServer() as any, undefined, { transport: transport as any });
    const wire = serveCall().options?.transport;

    expect(StdioServerTransport).not.toHaveBeenCalled();
    await wire?.start();
    await wire?.send({ jsonrpc: '2.0', id: 1, result: {} }, { relatedRequestId: 1 });
    wire?.setProtocolVersion?.('2026-07-28');
    await wire?.close();
    const onerror = vi.fn();
    if (wire) wire.onerror = onerror;
    expect(transport.start).toHaveBeenCalledOnce();
    expect(transport.send).toHaveBeenCalledWith(
      { jsonrpc: '2.0', id: 1, result: {} },
      { relatedRequestId: 1 },
    );
    expect(transport.setProtocolVersion).toHaveBeenCalledWith('2026-07-28');
    expect(transport.close).toHaveBeenCalledOnce();
    expect(transport.onerror).toBe(onerror);
  });

  it('reports the URIs the connection listens to, read off its traffic', async () => {
    type Handler = (message: unknown, extra?: unknown) => void;
    const transport: { onmessage?: Handler; onclose?: () => void; send: () => Promise<void> } = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const events: string[] = [];
    startStdioTransport(
      (extras) => {
        extras.listens.attach({
          add: (uri) => events.push(`+${uri}`),
          remove: (uri) => events.push(`-${uri}`),
        });
        // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer stand-in
        return fakeServer() as any;
      },
      undefined,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stand-ins
      { transport: transport as any },
    );
    await serveCall().factory({ era: 'modern' });
    const wire = serveCall().options?.transport;
    const delivered = vi.fn();
    const closed = vi.fn();
    if (wire) {
      wire.onmessage = delivered;
      wire.onclose = closed;
    }
    const listen = (id: string, uri: string) => ({
      jsonrpc: '2.0',
      id,
      method: 'subscriptions/listen',
      params: { notifications: { resourceSubscriptions: [uri] } },
    });

    transport.onmessage?.(listen('l1', 'x'), { authInfo: undefined });
    transport.onmessage?.(listen('l2', 'y'));
    expect(delivered).toHaveBeenCalledWith(listen('l1', 'x'), { authInfo: undefined });
    await wire?.send({ jsonrpc: '2.0', id: 'l1', result: {} });
    expect(events).toEqual(['+x', '+y', '-x']);
    transport.onclose?.();
    expect(events).toEqual(['+x', '+y', '-x', '-y']);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('leaves the wire without a message handler when the entry clears its own', () => {
    const transport: { onmessage?: unknown; onclose?: () => void } = {};
    // biome-ignore lint/suspicious/noExplicitAny: minimal stand-ins
    startStdioTransport(() => fakeServer() as any, undefined, { transport: transport as any });
    const wire = serveCall().options?.transport;
    if (wire) {
      wire.onmessage = undefined;
      wire.onclose = undefined;
    }
    expect(transport.onmessage).toBeUndefined();
    expect(() => transport.onclose?.()).not.toThrow();
  });

  it('builds each server with a notifier bound to that server and one codec per process', async () => {
    const built: { server: ReturnType<typeof fakeServer>; extras: StdioBuildExtras }[] = [];
    startStdioTransport((extras) => {
      const server = fakeServer();
      built.push({ server, extras });
      // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer stand-in
      return server as any;
    });
    const { factory } = serveCall();

    // The discover probe and the pinned instance: two builds, one codec.
    await factory({ era: 'modern' });
    await factory({ era: 'modern' });
    built[1]?.extras.notifyResourceUpdated('test://ping');

    expect(built[1]?.server.server.sendResourceUpdated).toHaveBeenCalledWith({
      uri: 'test://ping',
    });
    expect(built[0]?.server.server.sendResourceUpdated).not.toHaveBeenCalled();
    expect(built[0]?.extras.requestStateCodec).toBe(built[1]?.extras.requestStateCodec);
  });

  it('swallows a notification the transport cannot deliver', async () => {
    const server = {
      server: { sendResourceUpdated: vi.fn().mockRejectedValue(new Error('closed')) },
    };
    let notify: ((uri: string) => void) | undefined;
    startStdioTransport((extras) => {
      notify = extras.notifyResourceUpdated;
      // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer stand-in
      return server as any;
    });
    await serveCall().factory({ era: 'modern' });

    expect(() => notify?.('test://ping')).not.toThrow();
  });

  it('logs out-of-band transport errors', () => {
    const warn = vi.fn();
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer stand-in
    startStdioTransport(() => fakeServer() as any, logger);

    serveCall().options?.onerror?.(new Error('pipe broke'));

    expect(warn).toHaveBeenCalledWith('stdio_transport_error', { error: 'pipe broke' });
  });

  // The SDK constant is not what the guards derive from (that would let a
  // dependency bump move the published JSON Schema), but it is what tells us the
  // guards are still inside what the transport tolerates. A future SDK lowering
  // its default fails here instead of dropping sessions in production.
  it('keeps our ceiling within what the SDK accepts', () => {
    expect(STDIO_MAX_MESSAGE_BYTES).toBeLessThanOrEqual(STDIO_DEFAULT_MAX_BUFFER_SIZE);
  });
});
