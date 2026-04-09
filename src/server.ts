import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { Config } from './config';
import { createAllTools, type ToolDefinition } from './tools/index';
import { filterTools, groupByNamespace } from './routing/registry';

const NAMESPACE_LABELS: Record<string, { toolName: string; title: string }> = {
  tickets: { toolName: 'zendesk_tickets', title: 'Zendesk Tickets' },
  help_center: { toolName: 'zendesk_help_center', title: 'Zendesk Help Center' },
  users: { toolName: 'zendesk_users', title: 'Zendesk Users' },
};

const buildOperationList = (tools: ToolDefinition[]): string =>
  tools.map((t) => `- **${t.name}**: ${t.description}${t.readOnly ? '' : ' (write)'}`).join('\n');

const registerProxyTool = (
  server: McpServer,
  toolName: string,
  title: string,
  tools: ToolDefinition[],
  handlerMap: Map<string, ToolDefinition>,
): void => {
  const operationNames = tools.map((t) => t.name);
  const operationList = buildOperationList(tools);

  server.registerTool(
    toolName,
    {
      title,
      description: `${title}. Specify the operation and its parameters.\n\nAvailable operations:\n${operationList}`,
      inputSchema: z.object({
        operation: z.string().describe(`One of: ${operationNames.join(', ')}`),
        params: z.record(z.string(), z.unknown()).default({}).describe('Operation parameters'),
      }),
    },
    async ({ operation, params }) => {
      const def = handlerMap.get(operation);
      if (!def) {
        return {
          content: [{ type: 'text' as const, text: `Unknown operation "${operation}". Available: ${operationNames.join(', ')}` }],
        };
      }
      // Validate params through the tool's own schema
      const validated = def.inputSchema.parse(params);
      return def.handler(validated);
    },
  );
};

export const createMcpServer = (config: Config, getToken: () => string | Promise<string>): McpServer => {
  const server = new McpServer({
    name: '@digital4better/zendesk-mcp-server',
    version: '0.1.0',
  });

  const allTools = createAllTools({ subdomain: config.subdomain, getToken });

  // Apply filters (--read-only, --namespace, --tool)
  const filteredTools = filterTools(allTools, {
    readOnly: config.readOnly,
    namespaces: config.namespaces,
    tools: config.tools,
  });

  // Build handler map for proxy dispatch
  const handlerMap = new Map<string, ToolDefinition>();
  for (const tool of filteredTools) {
    handlerMap.set(tool.name, tool);
  }

  switch (config.mode) {
    case 'all': {
      // Register each tool individually
      for (const tool of filteredTools) {
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          },
          async (params) => tool.handler(params as Record<string, unknown>),
        );
      }
      break;
    }
    case 'namespace': {
      const grouped = groupByNamespace(filteredTools);
      for (const [namespace, tools] of grouped) {
        const label = NAMESPACE_LABELS[namespace];
        if (label) {
          registerProxyTool(server, label.toolName, label.title, tools, handlerMap);
        }
      }
      break;
    }
    case 'single': {
      registerProxyTool(server, 'zendesk', 'Zendesk', filteredTools, handlerMap);
      break;
    }
  }

  console.error(`Registered ${filteredTools.length} tools in ${config.mode} mode`);
  return server;
};
