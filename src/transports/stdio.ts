import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export const startStdioTransport = async (server: McpServer): Promise<void> => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Zendesk MCP server running via stdio');
};
