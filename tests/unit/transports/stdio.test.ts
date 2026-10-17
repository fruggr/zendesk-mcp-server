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
    expect(serveCall().options?.transport).toBe(vi.mocked(StdioServerTransport).mock.instances[0]);
  });

  it('serves over the transport it is given instead', () => {
    const transport = { start: vi.fn() };
    // biome-ignore lint/suspicious/noExplicitAny: minimal stand-ins
    startStdioTransport(() => fakeServer() as any, undefined, { transport: transport as any });

    expect(StdioServerTransport).not.toHaveBeenCalled();
    expect(serveCall().options?.transport).toBe(transport);
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
