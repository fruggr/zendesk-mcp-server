import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
  type ServerContext,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { createBrandSubdomainResolver } from './client/brands';
import { ZendeskApiError } from './client/zendesk-api';
import type { Config } from './config';
import { ARTICLE_RESOURCES_SCAN_MAX_PAGES } from './constants';
import { createArticleResourcesProvider } from './guidance/article-resources';
import {
  articleResourceEnabled,
  articleResourceUri,
  articleResourceUriTemplate,
  buildInstructions,
  helpCenterContextEnabled,
  promotedArticlesEnabled,
  slaAlertsEnabled,
  topologyResourceUri,
} from './guidance/instructions';
import { createTopologyProvider } from './guidance/topology';
import {
  buildOperationFieldDescription,
  buildProxyDescription,
  PARAMS_FIELD_DESCRIPTION,
} from './routing/proxy-schema';
import { filterTools, groupByNamespace, NAMESPACE_LABELS } from './routing/registry';
import type { ToolAnnotations, ToolCallContext, ToolResult } from './tools/definitions';
import { resolveBrand } from './tools/help-center';
import { createAllTools, type ToolDefinition } from './tools/index';
import { type AlertsReader, createAlertsReader } from './tools/sla-alerts';
import { isInputRequiredError, supportsFormElicitation } from './utils/elicitation';
import { type Logger, silentLogger } from './utils/logger';
import { readPackageInfo } from './utils/package-info';
import { type AlertPoller, createAlertPoller } from './utils/sla-poller';
import {
  NAMED_SCOPES,
  namedAlertsUri,
  parseAlertsUri,
  SLA_ALERTS_TEMPLATES,
  SLA_RESOURCE_SCHEME,
} from './utils/sla-resource';
import {
  createSlaRuntime,
  createSlaService,
  createUserIdResolver,
  type SlaRuntime,
  type SlaService,
} from './utils/sla-service';
import { createStrictParamsParser, toStrictStandardSchema } from './utils/validation';

/**
 * Invoke a tool handler, notifying `onUnauthorized` when Zendesk rejects the
 * token (401), so the OAuth store drops the dead token instead of replaying it.
 * The callback is omitted only where there is nothing to invalidate (the HTTP
 * per-session bearer, owned by the client).
 *
 * The 401 is a *backstop*, not a transparent retry: the current call still
 * surfaces the error, and recovery happens on the *next* one, whose `getToken`
 * refreshes silently (or falls back to browser re-auth). Proactive refresh keeps
 * this rare — it fires only for a token revoked between the pre-call check and
 * the request.
 */
const runHandler = async (
  def: ToolDefinition,
  params: Record<string, unknown>,
  onUnauthorized: (() => void) | undefined,
  call: ToolCallContext | undefined,
): Promise<ToolResult> => {
  try {
    return await def.handler(params, call);
  } catch (err) {
    // A handler asking the user something: hand the SDK its `input_required`
    // result, which it relays (or, for a 2025-era client, turns into an
    // `elicitation/create` round) before calling the handler again.
    if (isInputRequiredError(err)) return err.inputRequired as unknown as ToolResult;
    if (onUnauthorized && err instanceof ZendeskApiError && err.status === 401) {
      onUnauthorized();
    }
    throw err;
  }
};

/** The parts of the SDK request context a tool handler may use. */
export const toCallContext = (server: McpServer, ctx: ServerContext): ToolCallContext => ({
  canElicit: supportsFormElicitation(server.server.getClientCapabilities()),
  inputResponses: ctx.mcpReq.inputResponses,
});

// A proxy aggregates N sub-operations. Hints follow the safest plausible
// reading: readOnly/idempotent only if EVERY op is, destructive and openWorld
// as soon as ANY op is (every Zendesk op is open-world; only the preferences
// namespace stays on this server).
// Clients that never show annotations to the model get the `[RO]` description
// prefix instead.
export const aggregateAnnotations = (
  tools: readonly Pick<ToolDefinition, 'annotations'>[],
): ToolAnnotations => ({
  readOnlyHint: tools.every((t) => t.annotations.readOnlyHint),
  destructiveHint: tools.some((t) => t.annotations.destructiveHint),
  idempotentHint: tools.every((t) => t.annotations.idempotentHint),
  openWorldHint: tools.some((t) => t.annotations.openWorldHint),
});

type ProxyDispatch = (args: Record<string, unknown>, call?: ToolCallContext) => Promise<ToolResult>;

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

  return async (args, call) => {
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
    return runHandler(entry.def, validated, onUnauthorized, call);
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
  const annotations = aggregateAnnotations(tools);
  const dispatch = buildProxyDispatch(tools, onUnauthorized);

  return server.registerTool(
    toolName,
    {
      title,
      // `[RO]` only where the proxy really writes nothing: `--read-only` keeps
      // the preferences proxy, which writes this server's own settings.
      description: buildProxyDescription({
        title,
        tools,
        readOnly: readOnlyMode && annotations.readOnlyHint,
      }),
      inputSchema: z.object({
        operation: z.string().describe(buildOperationFieldDescription(tools)),
        params: z.record(z.string(), z.unknown()).default({}).describe(PARAMS_FIELD_DESCRIPTION),
      }),
      annotations,
    },
    async (args, ctx) => dispatch(args as Record<string, unknown>, toCallContext(server, ctx)),
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
  /**
   * THE shared brand subdomain resolver for this server generation. Created
   * ONCE by createMcpServer / createReloadableServer and passed here so the
   * tools AND the topology/article resources resolve against a single cached
   * brand list — otherwise each consumer builds its own and one session costs
   * several `GET /brands` walks. Optional so test harnesses that register a
   * toolset without brands can omit it; the resources then fall back to a
   * local resolver (unset brandIds makes it a no-op anyway).
   */
  resolveBrandSubdomain?: (idOrSubdomain: string) => Promise<string>;
  // Called when a tool handler hits a 401 from Zendesk. Lets the OAuth token
  // store invalidate the rejected token. Omitted where there is nothing to
  // invalidate (e.g. the HTTP per-session bearer is owned by the client).
  onUnauthorized?: (() => void) | undefined;
  logger?: Logger;
  /**
   * The SLA service the tools got: the alert resources read with it. Optional
   * so harnesses without one simply get no alert resources.
   */
  sla?: SlaService | undefined;
}

const ALERTS_MIME = 'text/markdown';

// The three alert resource templates, read through `reader`. The named one
// lists its three URIs so a client can offer them without guessing.
const registerAlertResources = (server: McpServer, reader: AlertsReader): Removable[] => {
  const read = async (uri: URL) => ({
    contents: [
      { uri: uri.toString(), mimeType: ALERTS_MIME, text: await reader.read(uri.toString()) },
    ],
  });
  const describe =
    'SLA metrics breached or about to breach, one line each, grouped BREACHED / CRITICAL / WARNING and soonest first, against your alert thresholds; the same report as list_sla_alerts. Subscribe to be told when the set of alerts changes.';
  return [
    server.registerResource(
      'sla-alerts',
      new ResourceTemplate(SLA_ALERTS_TEMPLATES.named, {
        list: async () => ({
          resources: NAMED_SCOPES.map((scope) => ({
            uri: namedAlertsUri(scope),
            name: `SLA alerts: ${scope}`,
            mimeType: ALERTS_MIME,
          })),
        }),
      }),
      {
        title: 'Zendesk SLA alerts',
        description: `${describe} {scope} is mine, my_groups or all (unsolved tickets).`,
        mimeType: ALERTS_MIME,
      },
      read,
    ),
    server.registerResource(
      'sla-alerts-view',
      new ResourceTemplate(SLA_ALERTS_TEMPLATES.view, { list: undefined }),
      {
        title: 'Zendesk SLA alerts in a view',
        description: `${describe} {view} is a view title or id, as list_views shows it.`,
        mimeType: ALERTS_MIME,
      },
      read,
    ),
    server.registerResource(
      'sla-alerts-query',
      new ResourceTemplate(SLA_ALERTS_TEMPLATES.query, { list: undefined }),
      {
        title: 'Zendesk SLA alerts for a search',
        description: `${describe} {query} is any Zendesk ticket search query.`,
        mimeType: ALERTS_MIME,
      },
      read,
    ),
  ];
};

/**
 * The server pushing alert changes on its own: `resources/subscribe` and
 * `unsubscribe` (2025-era clients), a poller re-checking each subscribed URI
 * every `slaPollSeconds`, and `notifications/resources/updated` when a URI's
 * alert set changes. Installed once per server, before it connects, and only
 * with push on. Stops with the session.
 */
export const installAlertSubscriptions = (
  server: McpServer,
  config: Config,
  reader: AlertsReader,
  logger: Logger = silentLogger,
): AlertPoller => {
  const poller = createAlertPoller({
    intervalMs: config.slaPollSeconds * 1000,
    check: reader.fingerprint,
    notify: (uri) => server.server.sendResourceUpdated({ uri }),
    onError: (uri, error) =>
      logger.warn('sla_alerts_poll_failed', {
        uri,
        error: error instanceof Error ? error.message : String(error),
      }),
  });
  const subscribable = (uri: string): string => {
    if (!parseAlertsUri(uri)) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Only SLA alert resources (${SLA_RESOURCE_SCHEME}://alerts/...) can be subscribed to: ${uri}`,
      );
    }
    return uri;
  };
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler('resources/subscribe', (request) => {
    poller.subscribe(subscribable(request.params.uri));
    return {};
  });
  server.server.setRequestHandler('resources/unsubscribe', (request) => {
    poller.unsubscribe(request.params.uri);
    return {};
  });
  const previous = server.server.onclose;
  server.server.onclose = () => {
    poller.stop();
    previous?.();
  };
  return poller;
};

/**
 * Lazily resolve the Help Center subdomain the topology resource pins to: the
 * FIRST allowed brand when a list is set (named in the header), else undefined
 * (the account default). Uses the SHARED resolver so the topology and article
 * resources hit the same cached brand list the tools use; it only fires when a
 * brand list is set. Providers await it per read (cheap after the first), since
 * registerToolset is synchronous and cannot resolve up front.
 */
const firstBrandSubdomainResolver = (
  config: Config,
  resolveBrandSubdomain: (idOrSubdomain: string) => Promise<string>,
): (() => Promise<string | undefined>) => {
  const first = config.brandIds?.[0];
  if (first === undefined || first === 'all') return () => Promise.resolve(undefined);
  return () => resolveBrandSubdomain(first);
};

/**
 * Per-call brand guard for the article resource URIs in multi/all mode: the
 * {brand} slot of `<scheme>://brands/{brand}/articles/{id}` is resolved and
 * allow-list-checked EXACTLY like a tool call's `brand_id` (shared resolver,
 * same resolveBrand rules), returning the brand's subdomain for the Help
 * Center fetch. Unset/single modes never reach here — their URIs carry no
 * brand segment.
 */
// A brand named in an article-resource URI is checked like a tool call's
// brand_id in multi/all mode (allow-list via resolveBrand). Single-lock mode
// resolves its one entry directly instead: its unscoped URIs carry no brand id,
// and resolveBrand's single-lock path rejects undefined.
const resourceBrandResolver = (
  config: Config,
  resolveBrandSubdomain: (idOrSubdomain: string) => Promise<string>,
): ((idOrSubdomain: string) => Promise<string>) => {
  const singleLock = config.brandIds?.length === 1 && config.brandIds[0] !== 'all';
  return (idOrSubdomain: string) =>
    singleLock
      ? resolveBrandSubdomain(idOrSubdomain)
      : resolveBrand(idOrSubdomain, config.brandIds, resolveBrandSubdomain).then(
          (sub) => sub ?? config.subdomain,
        );
};

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
  {
    config,
    getToken,
    resolveBrandSubdomain,
    onUnauthorized,
    logger = silentLogger,
    sla,
  }: ToolsetParams,
  tools: ToolDefinition[],
): { dispose(): void; count: number } => {
  // Fall back to a local resolver only when the caller did not share one
  // (test harnesses, --print-tools). Production callers always pass it.
  const sharedResolver =
    resolveBrandSubdomain ?? createBrandSubdomainResolver(config.subdomain, getToken);
  const registered: Removable[] = [];
  const dispose = (): void => {
    for (const handle of registered) handle.remove();
  };

  // Apply filters (--read-only, --namespace, --tool).
  // All of them live in filterTools so `--print-tools` renders exactly this set;
  // a filter applied only here would make that diagnostic lie.
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
                description: tool.description,
                // The strict schema, wrapped so the SDK validates through the same
                // parser as the proxies: unknown keys are rejected rather than
                // stripped (#100), errors read alike in every mode (#206), and
                // clients still see additionalProperties:false.
                inputSchema: toStrictStandardSchema(tool.inputSchema),
                annotations: tool.annotations,
              },
              async (params, ctx) =>
                runHandler(
                  tool,
                  params as Record<string, unknown>,
                  onUnauthorized,
                  toCallContext(server, ctx),
                ),
            ),
          );
        }
        break;
      }
      case 'namespace': {
        const grouped = groupByNamespace(filteredTools);
        for (const [namespace, nsTools] of grouped) {
          // Total by construction: NAMESPACE_LABELS is typed Record<Namespace, ...>,
          // so a namespace without a label is a compile error, not a silent skip.
          // The guard is only here for noUncheckedIndexedAccess.
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
      default: {
        // `config.mode` is a closed union, so this is unreachable while the
        // types hold. It is the guard for a mode added to the union (or fed in
        // by a hand-edited config) without a branch here: fail at registration
        // rather than start a server exposing no tools at all.
        const unhandled: never = config.mode;
        throw new Error(`Unsupported tool mode: ${String(unhandled)}`);
      }
    }

    // Pull-only Help Center topology resource. Read on demand with the caller's
    // token (resolved at read time via getToken), so auth timing and ACL are
    // both correct. Registered only when the context is enabled; this also
    // advertises the `resources` capability (merged with `logging`).
    if (helpCenterContextEnabled(config)) {
      const topology = createTopologyProvider(
        getToken,
        config.subdomain,
        onUnauthorized,
        config.brandIds,
        firstBrandSubdomainResolver(config, sharedResolver),
      );
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

    // The read callback renders ANY article id as Markdown, so the template is
    // registered whenever help_center is active. The `list`
    // callback enumerates promoted articles only when the pre-listing is enabled,
    // and swallows scan failures: a transient error must not break resources/list,
    // which would hide the topology resource too. In multi/all mode the URIs
    // carry the brand segment (`<scheme>://brands/{brand}/articles/{id}`) and
    // the read resolves it through the shared allow-list + resolver, exactly
    // like a tool call's brand_id.
    if (articleResourceEnabled(config)) {
      const articles = createArticleResourcesProvider(
        getToken,
        config.subdomain,
        onUnauthorized,
        resourceBrandResolver(config, sharedResolver),
        config.brandIds,
      );
      const listPromotedEnabled = promotedArticlesEnabled(config);
      const template = new ResourceTemplate(articleResourceUriTemplate(config), {
        list: async () => {
          // Pre-listing off → no scan, no Zendesk request; read-by-id still works.
          if (!listPromotedEnabled) return { resources: [] };
          try {
            const { refs, truncated } = await articles.listPromoted();
            if (truncated) {
              logger.warn('article_resources_list_truncated', {
                max_pages: ARTICLE_RESOURCES_SCAN_MAX_PAGES,
                listed: refs.length,
              });
            }
            return {
              resources: refs.map((ref) => ({
                uri: articleResourceUri(config, ref.id, ref.brand),
                name: ref.brand === undefined ? ref.title : `${ref.title} (${ref.brand})`,
                title: ref.title,
                // Per-article description so clients that render `uri — description`
                // in a resource picker can tell the entries apart (without it, every
                // entry inherits the template's generic description and looks
                // identical). Lead with the title + id so the distinguishing part
                // survives the client truncating a long line.
                description:
                  ref.brand === undefined
                    ? `"${ref.title}" (article ${ref.id}) — promoted Help Center article, as Markdown.`
                    : `"${ref.title}" (article ${ref.id}, brand ${ref.brand}) — promoted Help Center article, as Markdown.`,
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
              'A Help Center article rendered as Markdown, addressed by id (by brand and id when the server runs multi-brand). The list surfaces the promoted (featured) articles so one can be pinned as context; any article id can be read, subject to your Zendesk read permissions.',
            mimeType: 'text/markdown',
          },
          async (uri, variables) => {
            const rawId = Array.isArray(variables['id']) ? variables['id'][0] : variables['id'];
            const id = Number(rawId);
            if (!Number.isSafeInteger(id) || id <= 0) {
              throw new Error(`Invalid article id in resource URI: ${uri.toString()}`);
            }
            const rawBrand = variables['brand'];
            const brand = Array.isArray(rawBrand) ? rawBrand[0] : rawBrand;
            return {
              contents: [
                {
                  uri: uri.toString(),
                  mimeType: 'text/markdown',
                  text: await articles.readArticle(id, brand),
                },
              ],
            };
          },
        ),
      );
    }
    if (sla && slaAlertsEnabled(config)) {
      registered.push(
        ...registerAlertResources(
          server,
          createAlertsReader({
            subdomain: config.subdomain,
            getToken,
            resolveBrandSubdomain: sharedResolver,
            sla,
          }),
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
  // The process-wide SLA state; every session of an HTTP server shares one.
  slaRuntime: SlaRuntime = createSlaRuntime(config),
): McpServer => {
  const server = createServerShell(config, logger);
  // ONE shared resolver for the whole server: tools, topology resource and
  // article resources all resolve against this single cached brand list, so a
  // session costs at most one `GET /brands` walk no matter how many consumers
  // resolve a brand.
  const resolveBrandSubdomain = createBrandSubdomainResolver(config.subdomain, getToken);
  const sla = createSlaService(
    config,
    slaRuntime,
    createUserIdResolver(config.subdomain, getToken),
  );
  const ctx = {
    subdomain: config.subdomain,
    brandIds: config.brandIds,
    resolveBrandSubdomain,
    getToken,
    sla,
  };
  registerToolset(
    server,
    { config, getToken, resolveBrandSubdomain, onUnauthorized, logger, sla },
    createAllTools(ctx),
  );
  if (config.slaPush && slaAlertsEnabled(config)) {
    installAlertSubscriptions(server, config, createAlertsReader(ctx), logger);
  }
  return server;
};
