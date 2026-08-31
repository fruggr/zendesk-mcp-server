import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { STDIO_MAX_MESSAGE_BYTES } from '../constants';
import { type Logger, silentLogger } from '../utils/logger';

export const startStdioTransport = async (
  server: McpServer,
  logger: Logger = silentLogger,
): Promise<void> => {
  // stdin/stdout are passed as undefined to keep the SDK's defaults (process
  // streams) while reaching the third argument, where our own ceiling replaces the
  // SDK default so the guards and the transport derive from one number. Passing
  // null instead of undefined would override those defaults and break the server.
  const transport = new StdioServerTransport(undefined, undefined, {
    maxBufferSize: STDIO_MAX_MESSAGE_BYTES,
  });
  await server.connect(transport);
  logger.info('stdio_transport_ready');
};
