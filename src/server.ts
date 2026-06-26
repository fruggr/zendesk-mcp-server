import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { ZendeskApiError } from './client/zendesk-api';
import type { Config } from './config';
import {
  buildInstructions,
  helpCenterContextEnabled,
  TOPOLOGY_RESOURCE_URI,
} from './guidance/instructions';
import { createTopologyProvider } from './guidance/topology';
import { filterTools, groupByNamespace } from './routing/registry';
import type { ToolAnnotations, ToolResult } from './tools/definitions';
import { createAllTools, type ToolDefinition } from './tools/index';
import { type Logger, silentLogger } from './utils/logger';
import { readPackageInfo } from './utils/package-info';
import { parseToolParams } from './utils/validation';

/**
 * Invoke a tool handler, notifying `onUnauthorized` when Zendesk rejects the
 * token (401). This lets the OAuth store drop the dead token so the next call
 * refreshes/re-authenticates instead of replaying a revoked token. The callback
 * is omitted only where there is nothing to invalidate (e.g. HTTP per-session
 * bearer, owned by the client).
 *
 * Client-visible behaviour on an in-flight revocation: the 401 is a *backstop*,
 * not a transparent retry. The current call still surfaces the error; recovery
 * happens on the *next* call, whose `getToken` sees the invalidated token and
 * silently refreshes (or falls back to browser re-auth if the refresh token is
 * also dead). Proactive refresh keeps this path rare — it only fires when a
 * token is revoked between the pre-call refresh check and the request.
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
    // Strict-parse so an unknown/mistyped param fails loudly instead of being
    // silently dropped (#100). The throw is wrapped as an MCP tool error by the SDK.
    const validated = parseToolParams(def.inputSchema, params);
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
  // Called when a tool handler hits a 401 from Zendesk. Lets the OAuth token
  // store invalidate the rejected token. Omitted where there is nothing to
  // invalidate (e.g. the HTTP per-session bearer is owned by the client).
  onUnauthorized?: () => void,
): McpServer => {
  // Read name/version from package.json at runtime rather than hardcoding them
  // (the old literals were stale and even carried the wrong package name).
  const pkg = readPackageInfo();
  // Static, I/O-free Help Center context auto-loaded by clients on initialize.
  // Built before connect; undefined (and omitted) when the context is disabled.
  const instructions = buildInstructions(config);
  const server = new McpServer(
    {
      name: pkg.name,
      version: pkg.version,
    },
    // Advertise the logging capability so structured diagnostics (notably the
    // OAuth browser flow) reach clients that support it. Clients that don't
    // simply ignore the notifications. The `resources` capability is merged in
    // automatically by registerResource below. Spread `instructions` only when
    // present so the field is omitted entirely (exactOptionalPropertyTypes).
    { capabilities: { logging: {} }, ...(instructions ? { instructions } : {}) },
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
            // Register the strict schema (not just `.shape`) so the SDK rejects
            // unknown keys instead of silently stripping them, and advertises
            // additionalProperties:false to clients (#100).
            description: tool.description,
            inputSchema: tool.inputSchema.strict(),
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

  // Pull-only Help Center topology resource. Read on demand with the caller's
  // token (resolved at read time via getToken), so auth timing and ACL are
  // both correct. Registered only when the context is enabled; this also
  // advertises the `resources` capability (merged with `logging`).
  if (helpCenterContextEnabled(config)) {
    const topology = createTopologyProvider(getToken, config.subdomain, onUnauthorized);
    server.registerResource(
      'help-center-topology',
      TOPOLOGY_RESOURCE_URI,
      {
        title: 'Zendesk Help Center topology',
        description:
          'Active locales, category → section tree, visibility segments, permission groups, and your role. Read before creating or editing content.',
        mimeType: 'text/markdown',
      },
      async (uri) => ({
        contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text: await topology.read() }],
      }),
    );
  }

  logger.info('tools_registered', { count: filteredTools.length, mode: config.mode });
  return server;
};
