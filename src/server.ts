import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { ZendeskApiError } from './client/zendesk-api';
import type { Config } from './config';
import { ARTICLE_RESOURCES_SCAN_MAX_PAGES } from './constants';
import { createArticleResourcesProvider } from './guidance/article-resources';
import {
  articleResourcesEnabled,
  articleResourceUri,
  articleResourceUriTemplate,
  buildInstructions,
  helpCenterContextEnabled,
  topologyResourceUri,
} from './guidance/instructions';
import { createTopologyProvider } from './guidance/topology';
import { filterTools, groupByNamespace } from './routing/registry';
import type { ToolAnnotations, ToolResult } from './tools/definitions';
import { createAllTools, type ToolDefinition } from './tools/index';
import { type Logger, silentLogger } from './utils/logger';
import { readPackageInfo } from './utils/package-info';
import { createStrictParamsParser } from './utils/validation';

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
  // Each entry carries a strict params parser built once here (not per call) so
  // an unknown/mistyped param fails loudly instead of being silently dropped (#100).
  const localHandlers = new Map(
    tools.map((t) => [t.name, { def: t, parseParams: createStrictParamsParser(t.inputSchema) }]),
  );

  return async (args) => {
    const { operation, params } = args as {
      operation: string;
      params: Record<string, unknown>;
    };
    const entry = localHandlers.get(operation);
    if (!entry) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Unknown operation "${operation}". Available: ${operationNames.join(', ')}`,
          },
        ],
      };
    }
    // The throw is wrapped as an MCP tool error by the SDK.
    const validated = entry.parseParams(params);
    return runHandler(entry.def, validated, onUnauthorized);
  };
};

// A minimal structural view of what the SDK's `registerTool`/`registerResource`
// return: enough to tear the registration back down. Kept structural (not the
// SDK's `RegisteredTool`/`RegisteredResource` types) so tools and resources
// collect into one homogeneous list.
interface Removable {
  remove(): void;
}

const registerProxyTool = (
  server: McpServer,
  toolName: string,
  title: string,
  tools: ToolDefinition[],
  readOnlyMode: boolean,
  onUnauthorized: (() => void) | undefined,
): Removable => {
  const operationNames = tools.map((t) => t.name);
  const operationList = buildOperationList(tools);
  const annotations = aggregateAnnotations(tools);
  const prefix = readOnlyMode ? '[RO] ' : '';

  const dispatch = buildProxyDispatch(tools, onUnauthorized);

  return server.registerTool(
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

/**
 * Build the bare `McpServer` — identity, capabilities, `instructions` and the
 * logging sink — with no tools or resources registered yet. Split out from
 * `createMcpServer` so the dev reload (`dev/reload.ts`) can keep this
 * long-lived shell (and its transport/session) alive while swapping the toolset
 * underneath it via `registerToolset`.
 */
export const createServerShell = (config: Config, logger: Logger = silentLogger): McpServer => {
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
  return server;
};

/** Inputs `registerToolset` needs beyond the tool definitions themselves. */
export interface ToolsetParams {
  config: Config;
  getToken: () => string | Promise<string>;
  // Called when a tool handler hits a 401 from Zendesk. Lets the OAuth token
  // store invalidate the rejected token. Omitted where there is nothing to
  // invalidate (e.g. the HTTP per-session bearer is owned by the client).
  onUnauthorized?: (() => void) | undefined;
  logger?: Logger;
}

/**
 * Registers one generation of the toolset (mode/filters applied) plus the
 * optional topology resource onto an existing server, and returns a handle
 * whose `dispose()` removes exactly what this call added. When the SDK server
 * is already connected, each `registerTool`/`remove` emits `list_changed`, so a
 * dispose-then-register cycle hot-swaps the exposed tools in place — this is the
 * mechanism the dev reload (`dev/reload.ts`) uses to reflect edited tool code
 * without dropping the transport. `tools` is passed in (not built here) so the
 * reload path can hand over freshly re-imported definitions.
 */
export const registerToolset = (
  server: McpServer,
  { config, getToken, onUnauthorized, logger = silentLogger }: ToolsetParams,
  tools: ToolDefinition[],
): { dispose(): void; count: number } => {
  const registered: Removable[] = [];
  const dispose = (): void => {
    for (const handle of registered) handle.remove();
  };

  // Apply filters (--read-only, --namespace, --tool)
  const filteredTools = filterTools(tools, {
    readOnly: config.readOnly,
    namespaces: config.namespaces,
    tools: config.tools,
  });

  // Registration is atomic: if any registerTool/registerResource throws partway
  // (e.g. a hot-reloaded module introduced a duplicate tool name), roll back the
  // handles already registered. Otherwise the orphaned partial generation would
  // wedge the next reload with "Tool X is already registered".
  try {
    switch (config.mode) {
      case 'all': {
        for (const tool of filteredTools) {
          registered.push(
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
            ),
          );
        }
        break;
      }
      case 'namespace': {
        const grouped = groupByNamespace(filteredTools);
        for (const [namespace, nsTools] of grouped) {
          const label = NAMESPACE_LABELS[namespace];
          if (label) {
            registered.push(
              registerProxyTool(
                server,
                label.toolName,
                label.title,
                nsTools,
                config.readOnly,
                onUnauthorized,
              ),
            );
          }
        }
        break;
      }
      case 'single': {
        registered.push(
          registerProxyTool(
            server,
            'zendesk',
            'Zendesk',
            filteredTools,
            config.readOnly,
            onUnauthorized,
          ),
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
      registered.push(
        server.registerResource(
          'help-center-topology',
          topologyResourceUri(config),
          {
            title: 'Zendesk Help Center topology',
            description:
              'Active locales, category → section tree, visibility segments, permission groups, and your role. Useful context when creating or editing content; admin-only sections (permission groups, user segments) are marked unavailable rather than empty when your role lacks Guide-admin rights.',
            mimeType: 'text/markdown',
          },
          async (uri) => ({
            contents: [
              { uri: uri.toString(), mimeType: 'text/markdown', text: await topology.read() },
            ],
          }),
        ),
      );
    }

    // Pull-only Help Center article resources (zendesk-hc://article/{id}). The
    // template's `list` callback enumerates the promoted articles so a client can
    // surface them for pinning; the read callback renders ANY article id (Zendesk
    // ACLs enforced via the caller's token) as Markdown. Both defer all I/O to
    // request time via the provider, preserving the lazy-auth invariant. The list
    // callback swallows fetch failures (returning an empty list, logged) so a
    // transient article scan error never breaks resources/list — which would also
    // hide the separately-registered topology resource.
    if (articleResourcesEnabled(config)) {
      const articles = createArticleResourcesProvider(getToken, config.subdomain, onUnauthorized);
      const template = new ResourceTemplate(articleResourceUriTemplate(config), {
        list: async () => {
          try {
            const { refs, truncated } = await articles.listPromoted();
            if (truncated) {
              logger.warn('article_resources_list_truncated', {
                max_pages: ARTICLE_RESOURCES_SCAN_MAX_PAGES,
                listed: refs.length,
              });
            }
            return {
              resources: refs.map((article) => ({
                uri: articleResourceUri(config, article.id),
                name: article.title,
                title: article.title,
                // Per-article description so clients that render `uri — description`
                // in a resource picker can tell the entries apart (without it, every
                // entry inherits the template's generic description and looks
                // identical). Lead with the title + id so the distinguishing part
                // survives the client truncating a long line.
                description: `"${article.title}" (article ${article.id}) — promoted Help Center article, as Markdown.`,
                mimeType: 'text/markdown',
              })),
            };
          } catch (err) {
            logger.warn('article_resources_list_failed', {
              error: err instanceof Error ? err.message : String(err),
            });
            return { resources: [] };
          }
        },
      });
      registered.push(
        server.registerResource(
          'help-center-article',
          template,
          {
            title: 'Zendesk Help Center article',
            description:
              'A Help Center article rendered as Markdown, addressed by id. The list surfaces the promoted (featured) articles so one can be pinned as context; any article id can be read, subject to your Zendesk read permissions.',
            mimeType: 'text/markdown',
          },
          async (uri, variables) => {
            const raw = Array.isArray(variables['id']) ? variables['id'][0] : variables['id'];
            const id = Number(raw);
            if (!Number.isSafeInteger(id) || id <= 0) {
              throw new Error(`Invalid article id in resource URI: ${uri.toString()}`);
            }
            return {
              contents: [
                {
                  uri: uri.toString(),
                  mimeType: 'text/markdown',
                  text: await articles.readArticle(id),
                },
              ],
            };
          },
        ),
      );
    }
  } catch (err) {
    dispose();
    throw err;
  }

  logger.info('tools_registered', { count: filteredTools.length, mode: config.mode });

  return { count: filteredTools.length, dispose };
};

export const createMcpServer = (
  config: Config,
  getToken: () => string | Promise<string>,
  logger: Logger = silentLogger,
  onUnauthorized?: () => void,
): McpServer => {
  const server = createServerShell(config, logger);
  const tools = createAllTools({ subdomain: config.subdomain, getToken });
  registerToolset(server, { config, getToken, onUnauthorized, logger }, tools);
  return server;
};
