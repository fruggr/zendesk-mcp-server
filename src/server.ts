import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { ZendeskApiError } from './client/zendesk-api';
import type { Config } from './config';
import { filterTools, groupByNamespace } from './routing/registry';
import type { ToolAnnotations, ToolResult } from './tools/definitions';
import { createAllTools, type ToolDefinition } from './tools/index';
import { type Logger, silentLogger } from './utils/logger';
import { readPackageInfo } from './utils/package-info';

/**
 * Invoke a tool handler, notifying `onUnauthorized` when Zendesk rejects the
 * token (401). This lets the OAuth store drop the dead token so the next call
 * refreshes/re-authenticates instead of replaying a revoked token. A no-op
 * callback (API-token mode) leaves behavior unchanged.
 */
const runHandler = async (
  def: ToolDefinition,
  params: Record<string, unknown>,
  onUnauthorized: (() => void) | undefined,
): Promise<ToolResult> => {
  try {
    return await def.handler(params);
  } catch (err) {
    if (onUnauthorized && err instanceof ZendeskApiError && err.status === 401) {
      onUnauthorized();
    }
    throw err;
  }
};

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

// A proxy aggregates N sub-operations. Hints follow the safest plausible
// reading: readOnly/idempotent only if EVERY op is, destructive as soon as
// ANY op is. openWorld is always true (we always hit Zendesk).
// Mistral/Vibe ignore annotations entirely, hence the `[RO]` prefix below.
export const aggregateAnnotations = (
  tools: ReadonlyArray<Pick<ToolDefinition, 'annotations'>>,
): ToolAnnotations => ({
  readOnlyHint: tools.every((t) => t.annotations.readOnlyHint),
  destructiveHint: tools.some((t) => t.annotations.destructiveHint),
  idempotentHint: tools.every((t) => t.annotations.idempotentHint),
  openWorldHint: true,
});

type ProxyDispatch = (args: Record<string, unknown>) => Promise<ToolResult>;

// Each proxy carries its OWN handler map, scoped to the operations it
// advertises. In `namespace` mode this is essential: without it, a caller
// could invoke `zendesk_tickets` with operation="get_article" and dispatch
// a help-center handler via a shared global map. The description would lie
// but the call would still succeed.
export const buildProxyDispatch = (
  tools: ToolDefinition[],
  onUnauthorized: (() => void) | undefined,
): ProxyDispatch => {
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
    return runHandler(def, validated, onUnauthorized);
  };
};

const registerProxyTool = (
  server: McpServer,
  toolName: string,
  title: string,
  tools: ToolDefinition[],
  readOnlyMode: boolean,
  onUnauthorized: (() => void) | undefined,
): void => {
  const operationNames = tools.map((t) => t.name);
  const operationList = buildOperationList(tools);
  const annotations = aggregateAnnotations(tools);
  const prefix = readOnlyMode ? '[RO] ' : '';

  const dispatch = buildProxyDispatch(tools, onUnauthorized);

  server.registerTool(
    toolName,
    {
      title,
      description: `${prefix}${title}. Specify the operation and its parameters.\n\nAvailable operations:\n${operationList}`,
      inputSchema: {
        operation: z.string().describe(`One of: ${operationNames.join(', ')}`),
        params: z.record(z.string(), z.unknown()).default({}).describe('Operation parameters'),
      },
      annotations,
    },
    async (args) => dispatch(args as Record<string, unknown>),
  );
};

export const createMcpServer = (
  config: Config,
  getToken: () => string | Promise<string>,
  logger: Logger = silentLogger,
  // Called when a tool handler hits a 401 from Zendesk (OAuth mode only). Lets
  // the token store invalidate the rejected token. Omitted in API-token mode.
  onUnauthorized?: () => void,
): McpServer => {
  // Read name/version from package.json at runtime rather than hardcoding them
  // (the old literals were stale and even carried the wrong package name).
  const pkg = readPackageInfo();
  const server = new McpServer(
    {
      name: pkg.name,
      version: pkg.version,
    },
    // Advertise the logging capability so structured diagnostics (notably the
    // OAuth browser flow) reach clients that support it. Clients that don't
    // simply ignore the notifications.
    { capabilities: { logging: {} } },
  );

  // Route the logger's MCP sink through this server. Auth runs lazily on the
  // first tool call (after connect), so notifications can flow by then.
  logger.attachServer(server);

  const allTools = createAllTools({ subdomain: config.subdomain, getToken });

  // Apply filters (--read-only, --namespace, --tool)
  const filteredTools = filterTools(allTools, {
    readOnly: config.readOnly,
    namespaces: config.namespaces,
    tools: config.tools,
  });

  switch (config.mode) {
    case 'all': {
      for (const tool of filteredTools) {
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema.shape,
            annotations: tool.annotations,
          },
          async (params) => runHandler(tool, params as Record<string, unknown>, onUnauthorized),
        );
      }
      break;
    }
    case 'namespace': {
      const grouped = groupByNamespace(filteredTools);
      for (const [namespace, tools] of grouped) {
        const label = NAMESPACE_LABELS[namespace];
        if (label) {
          registerProxyTool(
            server,
            label.toolName,
            label.title,
            tools,
            config.readOnly,
            onUnauthorized,
          );
        }
      }
      break;
    }
    case 'single': {
      registerProxyTool(
        server,
        'zendesk',
        'Zendesk',
        filteredTools,
        config.readOnly,
        onUnauthorized,
      );
      break;
    }
  }

  logger.info('tools_registered', { count: filteredTools.length, mode: config.mode });
  return server;
};
