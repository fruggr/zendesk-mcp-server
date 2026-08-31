import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { describe, expect, it, vi } from 'vitest';
import { STDIO_MAX_MESSAGE_BYTES } from '../../../src/constants';
import { startStdioTransport } from '../../../src/transports/stdio';

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

const fakeServer = { connect: vi.fn().mockResolvedValue(undefined) };

describe('startStdioTransport', () => {
  it('hands our own ceiling to the transport instead of relying on the SDK default', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer stand-in
    await startStdioTransport(fakeServer as any);

    expect(StdioServerTransport).toHaveBeenCalledWith(undefined, undefined, {
      maxBufferSize: STDIO_MAX_MESSAGE_BYTES,
    });
    expect(fakeServer.connect).toHaveBeenCalledOnce();
  });

  // The SDK constant is not what the guards derive from (that would let a
  // dependency bump move the published JSON Schema), but it is what tells us the
  // guards are still inside what the transport tolerates. A future SDK lowering
  // its default fails here instead of dropping sessions in production.
  it('keeps our ceiling within what the SDK accepts', () => {
    expect(STDIO_MAX_MESSAGE_BYTES).toBeLessThanOrEqual(STDIO_DEFAULT_MAX_BUFFER_SIZE);
  });
});
