import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { Config } from './config';
import { filterTools, groupByNamespace } from './routing/registry';
import { createAllTools, type ToolDefinition } from './tools/index';

const NAMESPACE_LABELS: Record<string, { toolName: string; title: string }> = {
  tickets: { toolName: 'zendesk_tickets', title: 'Zendesk Tickets' },
  help_center: { toolName: 'zendesk_help_center', title: 'Zendesk Help Center' },
  users: { toolName: 'zendesk_users', title: 'Zendesk Users' },
};

// Keep proxy descriptions compact: a proxy tool concatenates one line per
// sub-operation, so only the first sentence of each tool description is
// included. Clients still receive the full schema via the wrapped tool.
export const summarizeDescription = (description: string): string => {
  const idx = description.indexOf('. ');
  if (idx === -1) return description;
  return description.slice(0, idx + 1);
};

export const buildOperationList = (
  tools: ReadonlyArray<Pick<ToolDefinition, 'name' | 'description' | 'readOnly'>>,
): string =>
  tools
    .map(
      (t) =>
        `- **${t.name}**: ${summarizeDescription(t.description)}${t.readOnly ? '' : ' (write)'}`,
    )
    .join('\n');

type ProxyDispatch = (args: Record<string, unknown>) => Promise<{
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
}>;

// Each proxy carries its OWN handler map, scoped to the operations it
// advertises. In `namespace` mode this is essential: without it, a caller
// could invoke `zendesk_tickets` with operation="get_article" and dispatch
// a help-center handler via a shared global map. The description would lie
// but the call would still succeed.
export const buildProxyDispatch = (tools: ToolDefinition[]): ProxyDispatch => {
  const operationNames = tools.map((t) => t.name);
  const localHandlers = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));

  return async (args) => {
    const { operation, params } = args as {
      operation: string;
      params: Record<string, unknown>;
    };
    const def = localHandlers.get(operation);
    if (!def) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Unknown operation "${operation}". Available: ${operationNames.join(', ')}`,
          },
        ],
      };
    }
    const validated = def.inputSchema.parse(params);
    return def.handler(validated);
  };
};

const registerLeafTool = (server: McpServer, def: ToolDefinition): void => {
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema.shape,
      annotations: def.annotations,
    },
    async (params) => def.handler(params as Record<string, unknown>),
  );
};

const registerProxyTool = (
  server: McpServer,
  toolName: string,
  title: string,
  tools: ToolDefinition[],
): void => {
  const operationNames = tools.map((t) => t.name);
  const operationList = buildOperationList(tools);
  const allReadOnly = tools.every((t) => t.readOnly);

  const dispatch = buildProxyDispatch(tools);

  server.registerTool(
    toolName,
    {
      title,
      description: `${title}. Specify the operation and its parameters.\n\nAvailable operations:\n${operationList}`,
      inputSchema: {
        operation: z.string().describe(`One of: ${operationNames.join(', ')}`),
        params: z.record(z.string(), z.unknown()).default({}).describe('Operation parameters'),
      },
      annotations: {
        title,
        readOnlyHint: allReadOnly,
        destructiveHint: !allReadOnly,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => dispatch(args as Record<string, unknown>),
  );
};

export interface CreatedServer {
  server: McpServer;
  registeredToolNames: string[];
}

export const createMcpServer = (
  config: Config,
  getToken: () => string | Promise<string>,
): CreatedServer => {
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

  const registeredToolNames: string[] = [];

  switch (config.mode) {
    case 'all': {
      for (const tool of filteredTools) {
        registerLeafTool(server, tool);
        registeredToolNames.push(tool.name);
      }
      break;
    }
    case 'namespace': {
      const grouped = groupByNamespace(filteredTools);
      for (const [namespace, tools] of grouped) {
        const label = NAMESPACE_LABELS[namespace];
        if (label) {
          registerProxyTool(server, label.toolName, label.title, tools);
          registeredToolNames.push(label.toolName);
        }
      }
      break;
    }
    case 'single': {
      registerProxyTool(server, 'zendesk', 'Zendesk', filteredTools);
      registeredToolNames.push('zendesk');
      break;
    }
  }

  console.error(`Registered ${filteredTools.length} tools in ${config.mode} mode`);
  return { server, registeredToolNames };
};
