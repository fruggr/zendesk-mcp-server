import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { type Logger, silentLogger } from '../utils/logger';

export const startStdioTransport = async (
  server: McpServer,
  logger: Logger = silentLogger,
): Promise<void> => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('stdio_transport_ready');
};
