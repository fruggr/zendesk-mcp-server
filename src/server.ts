import {
  CLIENT_CAPABILITIES_META_KEY,
  type ClientCapabilities,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type RequestStateCodec,
  ResourceTemplate,
  type ServerContext,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { type BrandSubdomainResolver, createBrandSubdomainResolver } from './client/brands';
import { ZendeskApiError } from './client/zendesk-api';
import type { Config } from './config';
import { ARTICLE_RESOURCES_SCAN_MAX_PAGES } from './constants';
import {
  type ArticleResourcesProvider,
  createArticleResourcesProvider,
} from './guidance/article-resources';
import {
  articleResourceEnabled,
  articleResourceUri,
  articleResourceUriTemplate,
  buildInstructions,
  helpCenterContextEnabled,
  promotedArticlesEnabled,
  slaAlertsEnabled,
  slaPreferencesEnabled,
  topologyResourceUri,
} from './guidance/instructions';
import { createTopologyProvider, type TopologyProvider } from './guidance/topology';
import {
  buildOperationFieldDescription,
  buildProxyDescription,
  PARAMS_FIELD_DESCRIPTION,
} from './routing/proxy-schema';
import { filterTools, groupByNamespace, NAMESPACE_LABELS } from './routing/registry';
import type { ToolAnnotations, ToolCallContext, ToolResult } from './tools/definitions';
import { resolveBrand } from './tools/help-center';
import { createAllTools, type ToolContext, type ToolDefinition } from './tools/index';
import { type AlertsReader, createAlertsReader } from './tools/sla-alerts';
import { isInputRequiredError, supportsFormElicitation } from './utils/elicitation';
import type { ListenFeed } from './utils/listen-feed';
import { type Logger, silentLogger } from './utils/logger';
import { readPackageInfo } from './utils/package-info';
import { createRequestStateCodec } from './utils/request-state';
import { isSignInRequired } from './utils/sign-in-required';
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

const noteUnauthorized = (err: unknown, onUnauthorized: (() => void) | undefined): void => {
  if (onUnauthorized && err instanceof ZendeskApiError && err.status === 401) onUnauthorized();
};

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
    noteUnauthorized(err, onUnauthorized);
    throw err;
  }
};

/** The parts of the SDK request context a tool handler may use. */
export const toCallContext = (server: McpServer, ctx: ServerContext): ToolCallContext => ({
  // A 2026-07-28 request declares the client's capabilities itself; the
  // instance-wide ones are the `initialize` ones, never set on a stdio 2026 connection.
  canElicit: supportsFormElicitation(
    (ctx.mcpReq.envelope as Record<string, ClientCapabilities | undefined> | undefined)?.[
      CLIENT_CAPABILITIES_META_KEY
    ] ?? server.server.getClientCapabilities(),
  ),
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
 * `single` mode: one `zendesk` proxy for every Zendesk tool. The preferences
 * configure this server, not Zendesk: they keep their own proxy, so `zendesk`
 * stays `[RO]` and readOnlyHint under --read-only.
 */
const registerSingleProxies = (
  server: McpServer,
  tools: ToolDefinition[],
  readOnlyMode: boolean,
  onUnauthorized: (() => void) | undefined,
): Removable[] => {
  const preferences = tools.filter((tool) => tool.namespace === 'preferences');
  const zendesk = tools.filter((tool) => tool.namespace !== 'preferences');
  const label = NAMESPACE_LABELS.preferences;
  return [
    ...(zendesk.length > 0 || preferences.length === 0
      ? [registerProxyTool(server, 'zendesk', 'Zendesk', zendesk, readOnlyMode, onUnauthorized)]
      : []),
    ...(preferences.length > 0
      ? [
          registerProxyTool(
            server,
            label.toolName,
            label.title,
            preferences,
            readOnlyMode,
            onUnauthorized,
          ),
        ]
      : []),
  ];
};

/**
 * Build the bare `McpServer` — identity, `instructions` — with no tools or
 * resources registered yet. Split out from `createMcpServer` so the dev reload
 * (`dev/reload.ts`) can keep this long-lived shell (and its transport/session)
 * alive while swapping the toolset underneath it via `registerToolset`.
 */
export const createServerShell = (
  config: Config,
  // Every server verifies echoed `requestState`; see utils/request-state.ts.
  requestStateCodec: RequestStateCodec = createRequestStateCodec({}),
): McpServer => {
  // Read name/version from package.json at runtime rather than hardcoding them
  // (the old literals were stale and even carried the wrong package name).
  const pkg = readPackageInfo();
  // Static, I/O-free Help Center context auto-loaded by clients on initialize.
  // Built before connect; undefined (and omitted) when the context is disabled.
  const instructions = buildInstructions(config);
  // No `logging` capability: diagnostics go to stderr only (see utils/logger.ts).
  // The `resources` capability is merged in by registerResource below. Spread
  // `instructions` only when present so the field is omitted entirely
  // (exactOptionalPropertyTypes).
  return new McpServer(
    { name: pkg.name, version: pkg.version },
    {
      ...(instructions ? { instructions } : {}),
      requestState: { verify: (state, ctx) => requestStateCodec.verify(state, ctx) },
    },
  );
};

/**
 * The Zendesk data a server caches between calls (brand list, Help Center
 * topology, promoted-article pre-listing; each with its own TTL). What they hold
 * depends on the caller's Zendesk role, so they belong to ONE user. A
 * long-lived server builds its own; per-request servers (HTTP 2026-07-28) are
 * handed the caches their grant keeps, or each request would refetch them.
 */
export interface ServerCaches {
  resolveBrandSubdomain: BrandSubdomainResolver;
  /** Undefined when the Help Center context is off. */
  topology: TopologyProvider | undefined;
  /** Undefined when the article resources are off. */
  articles: ArticleResourcesProvider | undefined;
  /** The caller's Zendesk user id, read once per token: SLA state is keyed by it. */
  resolveUserId: () => Promise<number>;
}

export const createServerCaches = (
  config: Config,
  getToken: () => string | Promise<string>,
  onUnauthorized?: () => void,
): ServerCaches => {
  // ONE resolver for the tools AND the topology/article resources, so they
  // resolve against a single cached brand list: one `GET /brands` walk, not one
  // per consumer.
  const resolveBrandSubdomain = createBrandSubdomainResolver(config.subdomain, getToken);
  return {
    resolveBrandSubdomain,
    resolveUserId: createUserIdResolver(config.subdomain, getToken),
    topology: helpCenterContextEnabled(config)
      ? createTopologyProvider(
          getToken,
          config.subdomain,
          onUnauthorized,
          config.brandIds,
          firstBrandSubdomainResolver(config, resolveBrandSubdomain),
        )
      : undefined,
    articles: articleResourceEnabled(config)
      ? createArticleResourcesProvider(
          getToken,
          config.subdomain,
          onUnauthorized,
          resourceBrandResolver(config, resolveBrandSubdomain),
          config.brandIds,
        )
      : undefined,
  };
};

/** Inputs `registerToolset` needs beyond the tool definitions themselves. */
export interface ToolsetParams {
  config: Config;
  getToken: () => string | Promise<string>;
  /**
   * The caches this generation reads through. Optional so test harnesses can
   * omit them; registerToolset then builds a fresh set.
   */
  caches?: ServerCaches;
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
const registerAlertResources = (
  server: McpServer,
  reader: AlertsReader,
  push: boolean,
): Removable[] => {
  const read = async (uri: URL) => ({
    contents: [
      { uri: uri.toString(), mimeType: ALERTS_MIME, text: await reader.read(uri.toString()) },
    ],
  });
  const subscribe = push ? ' Subscribe to be told when the set of alerts changes.' : '';
  const describe = `SLA metrics breached or about to breach, one line each, grouped BREACHED / CRITICAL / WARNING and soonest first, against your alert thresholds; the same report as list_sla_alerts.${subscribe}`;
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

/** Re-checks each subscribed URI every `slaPollSeconds`; notifies when its alert set changes. */
const createAlertsPoller = (
  config: Config,
  reader: AlertsReader,
  notify: (uri: string) => Promise<void>,
  logger: Logger,
): AlertPoller =>
  createAlertPoller({
    intervalMs: config.slaPollSeconds * 1000,
    check: reader.fingerprint,
    notify,
    onError: (uri, error) => {
      // Nobody signed in, and only a user action may open a sign-in: wait for one.
      if (isSignInRequired(error)) {
        logger.debug('sla_alerts_poll_skipped', { uri });
        return;
      }
      logger.warn('sla_alerts_poll_failed', {
        uri,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

/**
 * The SLA settings a server applies: personal thresholds only where
 * `configure_sla_alerts`, the one way to change them, is exposed.
 */
export const slaSettings = (config: Config): Config => ({
  ...config,
  slaUserPreferences: slaPreferencesEnabled(config),
});

/** The context the tools and the alert readers share. */
export const toolContext = (
  config: Config,
  getToken: () => string | Promise<string>,
  resolveBrandSubdomain: BrandSubdomainResolver,
  sla: SlaService,
): ToolContext => ({
  subdomain: config.subdomain,
  brandIds: config.brandIds,
  resolveBrandSubdomain,
  getToken,
  sla,
});

/** `reader`, with a Zendesk 401 reported like a tool's: the dead token is dropped, not replayed. */
const reportingUnauthorized = (
  reader: AlertsReader,
  onUnauthorized: (() => void) | undefined,
): AlertsReader => {
  const note = (err: unknown): never => {
    noteUnauthorized(err, onUnauthorized);
    throw err;
  };
  return {
    read: (uri) => reader.read(uri).catch(note),
    fingerprint: (uri) => reader.fingerprint(uri).catch(note),
  };
};

export interface AlertPollingReaderParams {
  config: Config;
  /** A token source that never prompts: polling is nobody's action. */
  getToken: () => string | Promise<string>;
  /** The caller's Zendesk user id, read with that same token source. */
  resolveUserId: () => Promise<number>;
  caches: ServerCaches;
  slaRuntime: SlaRuntime;
  onUnauthorized?: (() => void) | undefined;
}

/** The reader the SLA alert poller checks with. */
export const createAlertPollingReader = ({
  config,
  getToken,
  resolveUserId,
  caches,
  slaRuntime,
  onUnauthorized,
}: AlertPollingReaderParams): AlertsReader =>
  reportingUnauthorized(
    createAlertsReader(
      toolContext(
        config,
        getToken,
        caches.resolveBrandSubdomain,
        createSlaService(slaSettings(config), slaRuntime, resolveUserId),
      ),
    ),
    onUnauthorized,
  );

/**
 * The token source and user-id lookup a poller runs with: a background one
 * when the transport has it (stdio, whose `getToken` may open a browser).
 */
export const pollingIdentity = (
  config: Config,
  getToken: () => string | Promise<string>,
  caches: ServerCaches,
  getBackgroundToken: (() => string | Promise<string>) | undefined,
) =>
  getBackgroundToken
    ? {
        getToken: getBackgroundToken,
        resolveUserId: createUserIdResolver(config.subdomain, getBackgroundToken),
      }
    : { getToken, resolveUserId: caches.resolveUserId };

/** Polls the SLA alert resources a 2026-07-28 client listens to; other URIs are not ours. */
const pollListenedAlerts = (poller: AlertPoller, listens: Pick<ListenFeed, 'attach'>) =>
  listens.attach({
    add: (uri) => {
      if (parseAlertsUri(uri)) poller.subscribe(uri);
    },
    remove: (uri) => poller.unsubscribe(uri),
  });

/**
 * The server pushing alert changes on its own, through `resources/subscribe`
 * for a 2025 client and the `listens` streams for a 2026-07-28 one when the
 * server lives as long as its connection (stdio). Installed once per server,
 * before it connects, and only with push on. Stops with the server.
 */
export const installAlertSubscriptions = (
  server: McpServer,
  config: Config,
  reader: AlertsReader,
  logger: Logger = silentLogger,
  listens?: Pick<ListenFeed, 'attach'>,
): AlertPoller => {
  const poller = createAlertsPoller(
    config,
    reader,
    (uri) => server.server.sendResourceUpdated({ uri }),
    logger,
  );
  const subscribable = (uri: string): string => {
    if (!parseAlertsUri(uri)) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Only SLA alert resources (${SLA_RESOURCE_SCHEME}://alerts/...) can be subscribed to: ${uri}`,
      );
    }
    return uri;
  };
  // Also what lets a 2026-07-28 listen filter keep its resource URIs.
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler('resources/subscribe', (request) => {
    poller.subscribe(subscribable(request.params.uri));
    return {};
  });
  server.server.setRequestHandler('resources/unsubscribe', (request) => {
    poller.unsubscribe(request.params.uri);
    return {};
  });
  const detach = listens ? pollListenedAlerts(poller, listens) : undefined;
  const previous = server.server.onclose;
  server.server.onclose = () => {
    detach?.();
    poller.stop();
    previous?.();
  };
  return poller;
};

export interface GrantAlertWatchParams {
  config: Config;
  getToken: () => string | Promise<string>;
  caches: ServerCaches;
  slaRuntime: SlaRuntime;
  logger: Logger;
  listens: Pick<ListenFeed, 'attach'>;
  notify: (uri: string) => void;
  /** A Zendesk 401 while polling: the grant's token is dead. */
  onUnauthorized?: () => void;
}

/**
 * The SLA alert polling of a 2026-07-28 HTTP grant: its servers last one
 * request each, so the poller lives with the grant, fed by the grant's listen
 * streams. Returns the stop; a no-op when the push is off.
 */
export const watchGrantAlerts = ({
  config,
  getToken,
  caches,
  slaRuntime,
  logger,
  listens,
  notify,
  onUnauthorized,
}: GrantAlertWatchParams): (() => void) => {
  if (!(config.slaPush && slaAlertsEnabled(config))) return () => undefined;
  const reader = createAlertPollingReader({
    config,
    getToken,
    resolveUserId: caches.resolveUserId,
    caches,
    slaRuntime,
    onUnauthorized,
  });
  const poller = createAlertsPoller(
    config,
    reader,
    async (uri) => {
      notify(uri);
    },
    logger,
  );
  const detach = pollListenedAlerts(poller, listens);
  return () => {
    detach();
    poller.stop();
  };
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
  { config, getToken, caches, onUnauthorized, logger = silentLogger, sla }: ToolsetParams,
  tools: ToolDefinition[],
): { dispose(): void; count: number } => {
  const shared = caches ?? createServerCaches(config, getToken, onUnauthorized);
  const { topology, articles } = shared;
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
          ...registerSingleProxies(server, filteredTools, config.readOnly, onUnauthorized),
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
    // advertises the `resources` capability.
    if (topology) {
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
    if (articles) {
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
          reportingUnauthorized(
            createAlertsReader(toolContext(config, getToken, shared.resolveBrandSubdomain, sla)),
            onUnauthorized,
          ),
          config.slaPush,
        ),
      );
    }
  } catch (err) {
    dispose();
    throw err;
  }

  // Debug: a 2026-07-28 HTTP request builds a server, so this fires per request.
  logger.debug('tools_registered', { count: filteredTools.length, mode: config.mode });

  return { count: filteredTools.length, dispose };
};

/** The tool definitions and the SLA service they and the alert resources share. */
export interface Toolset {
  sla: SlaService;
  tools: ToolDefinition[];
}

/** The toolset for a server's config. */
export type ToolsetSource = (config: Config) => Toolset;

const buildToolset = (
  config: Config,
  getToken: () => string | Promise<string>,
  caches: ServerCaches,
  slaRuntime: SlaRuntime,
): Toolset => {
  const sla = createSlaService(slaSettings(config), slaRuntime, caches.resolveUserId);
  return {
    sla,
    tools: createAllTools(toolContext(config, getToken, caches.resolveBrandSubdomain, sla)),
  };
};

/**
 * A grant's toolsets (HTTP 2026-07-28), built on its first request and reused by
 * the next ones: building the definitions is most of a server's cost (#393).
 * They close over the grant's token and caches, so they never cross grants.
 * Keyed on `readOnly`, the one setting that differs between a grant's requests.
 */
export const createToolsetCache = (
  getToken: () => string | Promise<string>,
  caches: ServerCaches,
  slaRuntime: SlaRuntime,
): ToolsetSource => {
  const built = new Map<boolean, Toolset>();
  return (config) => {
    const known = built.get(config.readOnly);
    if (known) return known;
    const toolset = buildToolset(config, getToken, caches, slaRuntime);
    built.set(config.readOnly, toolset);
    return toolset;
  };
};

export interface CreateMcpServerOptions {
  /** Caches kept by the caller across servers; built per server when omitted. */
  caches?: ServerCaches;
  /** Toolsets kept by the caller across servers; built per server when omitted. */
  toolsets?: ToolsetSource;
  /** Built by the transport, which knows the key and the principal; a random-key one otherwise. */
  requestStateCodec?: RequestStateCodec;
  /** The process-wide SLA state: every server of a process shares one. */
  slaRuntime?: SlaRuntime;
  /** The listen streams of the connection this server serves for its lifetime (stdio). */
  listens?: Pick<ListenFeed, 'attach'>;
  /** A token source that never prompts, for the alert poller; `getToken` otherwise. */
  getBackgroundToken?: () => string | Promise<string>;
  /**
   * Who polls the subscribed alert resources: this server (default), or the
   * transport's grant (`grant`, 2026-07-28 HTTP: the server answers one request,
   * so it only advertises `resources.subscribe` for the listen filter).
   */
  alertPolling?: AlertPolling;
}

export type AlertPolling = 'server' | 'grant';

export const createMcpServer = (
  config: Config,
  getToken: () => string | Promise<string>,
  logger: Logger = silentLogger,
  onUnauthorized?: () => void,
  {
    caches = createServerCaches(config, getToken, onUnauthorized),
    requestStateCodec,
    slaRuntime = createSlaRuntime(config),
    listens,
    getBackgroundToken,
    alertPolling = 'server',
    toolsets = (cfg) => buildToolset(cfg, getToken, caches, slaRuntime),
  }: CreateMcpServerOptions = {},
): McpServer => {
  const server = createServerShell(config, requestStateCodec);
  const { sla, tools } = toolsets(config);
  registerToolset(server, { config, getToken, caches, onUnauthorized, logger, sla }, tools);
  if (config.slaPush && slaAlertsEnabled(config)) {
    if (alertPolling === 'grant') {
      server.server.registerCapabilities({ resources: { subscribe: true } });
    } else {
      const reader = createAlertPollingReader({
        config,
        ...pollingIdentity(config, getToken, caches, getBackgroundToken),
        caches,
        slaRuntime,
        onUnauthorized,
      });
      installAlertSubscriptions(server, config, reader, logger, listens);
    }
  }
  return server;
};

/**
 * What a transport hands the server factory for each server it needs: one per
 * stdio connection or 2025 HTTP session, one per 2026 HTTP request.
 */
export interface ServerBuildContext {
  /** Effective config: HTTP narrows `readOnly` from the token's scope. */
  config: Config;
  getToken: () => string | Promise<string>;
  logger: Logger;
  onUnauthorized?: () => void;
  caches?: ServerCaches;
  toolsets?: ToolsetSource;
  requestStateCodec: RequestStateCodec;
  slaRuntime?: SlaRuntime;
  /**
   * The listen streams of the connection the server serves for its lifetime;
   * absent where a server answers one request (2026-07-28 HTTP).
   */
  listens?: Pick<ListenFeed, 'attach'>;
  /** A token source that never prompts, for background work; `getToken` otherwise. */
  getBackgroundToken?: () => string | Promise<string>;
  /** Who polls subscribed alert resources; see `CreateMcpServerOptions`. */
  alertPolling?: AlertPolling;
  /**
   * Announces that a resource changed, to whoever listens to it on this
   * connection, session or grant. The URI is the whole payload, and a listen
   * stream is authenticated only when it opens: it must carry nothing
   * sensitive (no content, no personal data, nothing confidential in the URI).
   */
  notifyResourceUpdated: (uri: string) => void;
}

export type ServerFactory = (ctx: ServerBuildContext) => McpServer;

export const defaultServerFactory: ServerFactory = ({
  config,
  getToken,
  logger,
  onUnauthorized,
  caches,
  toolsets,
  requestStateCodec,
  slaRuntime,
  listens,
  getBackgroundToken,
  alertPolling,
}) =>
  createMcpServer(config, getToken, logger, onUnauthorized, {
    ...(caches ? { caches } : {}),
    ...(toolsets ? { toolsets } : {}),
    ...(slaRuntime ? { slaRuntime } : {}),
    ...(listens ? { listens } : {}),
    ...(getBackgroundToken ? { getBackgroundToken } : {}),
    ...(alertPolling ? { alertPolling } : {}),
    requestStateCodec,
  });
