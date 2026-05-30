import type { IncomingMessage } from 'node:http';
import { type ContentResult, FastMCP } from 'fastmcp';
import * as z from 'zod/v4';
import { runWithSessionToken } from './auth/session-token';
import type { Config } from './config';
import { getOAuthUrls } from './constants';
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

// fastmcp constrains the auth type to `Record<string, unknown> | undefined`.
// Extending the index signature lets us keep a typed accessToken field
// while satisfying that constraint.
interface SessionAuth extends Record<string, unknown> {
  accessToken: string;
}

interface ExecuteCtx {
  session?: SessionAuth | undefined;
}

type LeafExecute = (args: Record<string, unknown>) => Promise<ContentResult>;

// Error message must stay ASCII-only: mcp-proxy interpolates it into the
// WWW-Authenticate response header on 401, and node:http's setHeader rejects
// non-ASCII bytes with ERR_INVALID_CHAR (which would surface as a 500 instead
// of the spec-required 401).
export const extractBearer = (request: IncomingMessage): string => {
  const header = request.headers['authorization'];
  if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
    throw new Error(
      'Missing Authorization: Bearer <zendesk-oauth-token> header. ' +
        'HTTP mode requires per-user OAuth 2.1 PKCE - obtain a token from Zendesk via your MCP client.',
    );
  }
  return header.slice('bearer '.length).trim();
};

// Build the canonical `resource` URL we advertise in the OAuth metadata.
// Precedence:
//   1. Explicit --public-url / PUBLIC_URL (operators behind a reverse proxy
//      must set this; Azure App Service: PUBLIC_URL="https://${WEBSITE_HOSTNAME}").
//   2. host:port when host is a real, routable hostname or IP (not the bind
//      wildcard 0.0.0.0 / :: / unspecified).
//   3. Fallback to http://host:port + warning. Clients following RFC 8707
//      strictly will reject this resource identifier, so log a clear warning
//      so the operator knows to set PUBLIC_URL.
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '*']);

export const resolveResourceUrl = (config: Config): string => {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
  if (!WILDCARD_HOSTS.has(config.host)) {
    return `http://${config.host}:${config.port}`;
  }
  console.error(
    `[zendesk-mcp-server] WARNING: HOST=${config.host} but PUBLIC_URL is unset. ` +
      `OAuth discovery will advertise http://${config.host}:${config.port} as the ` +
      `resource identifier, which is not routable from external clients and may ` +
      `cause spec-compliant MCP clients to refuse the connection. Set PUBLIC_URL ` +
      `(or --public-url) to the URL clients use to reach this server (e.g. ` +
      `https://your-host.example.com).`,
  );
  return `http://${config.host}:${config.port}`;
};

// In stdio mode the token is captured in the tools' closures (getToken passed
// to createAllTools), so execute just invokes the handler. In HTTP mode the
// per-session bearer is in ctx.session.accessToken; we move it into
// async-local storage so the same closure-based getToken keeps working
// without threading a token argument through 37 tool handlers.
export const wrapLeafExecute = (
  config: Config,
  handler: ToolDefinition['handler'],
): ((args: unknown, ctx: ExecuteCtx) => Promise<ContentResult>) => {
  if (config.transport === 'stdio') {
    return async (args) => handler(args as Record<string, unknown>) as Promise<ContentResult>;
  }
  return async (args, ctx) => {
    const token = ctx.session?.accessToken;
    if (!token) {
      throw new Error('Session is missing accessToken — authenticate() did not populate it.');
    }
    return runWithSessionToken(
      token,
      () => handler(args as Record<string, unknown>) as Promise<ContentResult>,
    );
  };
};

export const wrapProxyExecute = (
  config: Config,
  body: LeafExecute,
): ((args: unknown, ctx: ExecuteCtx) => Promise<ContentResult>) => {
  if (config.transport === 'stdio') {
    return async (args) => body(args as Record<string, unknown>);
  }
  return async (args, ctx) => {
    const token = ctx.session?.accessToken;
    if (!token) {
      throw new Error('Session is missing accessToken — authenticate() did not populate it.');
    }
    return runWithSessionToken(token, () => body(args as Record<string, unknown>));
  };
};

const registerLeafTool = (
  server: FastMCP<SessionAuth>,
  def: ToolDefinition,
  config: Config,
): void => {
  server.addTool({
    name: def.name,
    description: def.description,
    parameters: def.inputSchema,
    annotations: {
      title: def.title,
      readOnlyHint: def.annotations.readOnlyHint,
      destructiveHint: def.annotations.destructiveHint,
      idempotentHint: def.annotations.idempotentHint,
      openWorldHint: def.annotations.openWorldHint,
    },
    execute: wrapLeafExecute(config, def.handler),
  });
};

// Each proxy carries its OWN handler map, scoped to the operations it
// advertises. In `namespace` mode this is essential: without it, a caller
// could invoke `zendesk_tickets` with operation="get_article" and dispatch
// a help-center handler via a shared global map. The description would lie
// but the call would still succeed.
export const buildProxyDispatch = (tools: ToolDefinition[]): LeafExecute => {
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

const registerProxyTool = (
  server: FastMCP<SessionAuth>,
  toolName: string,
  title: string,
  tools: ToolDefinition[],
  config: Config,
): void => {
  const operationNames = tools.map((t) => t.name);
  const operationList = buildOperationList(tools);
  const allReadOnly = tools.every((t) => t.readOnly);

  const dispatch = buildProxyDispatch(tools);

  server.addTool({
    name: toolName,
    description: `${title}. Specify the operation and its parameters.\n\nAvailable operations:\n${operationList}`,
    parameters: z.object({
      operation: z.string().describe(`One of: ${operationNames.join(', ')}`),
      params: z.record(z.string(), z.unknown()).default({}).describe('Operation parameters'),
    }),
    annotations: {
      title,
      readOnlyHint: allReadOnly,
      destructiveHint: !allReadOnly,
      idempotentHint: false,
      openWorldHint: true,
    },
    execute: wrapProxyExecute(config, dispatch),
  });
};

export interface CreatedServer {
  server: FastMCP<SessionAuth>;
  registeredToolNames: string[];
}

export const createMcpServer = (
  config: Config,
  getToken: () => string | Promise<string>,
): CreatedServer => {
  const httpOptions = (() => {
    if (config.transport !== 'http') return {};
    const { authorizeUrl, tokenUrl } = getOAuthUrls(config.subdomain);
    const issuer = `https://${config.subdomain}.zendesk.com`;
    const resource = resolveResourceUrl(config);
    return {
      authenticate: async (request: IncomingMessage): Promise<SessionAuth> => ({
        accessToken: extractBearer(request),
      }),
      // Advertise Zendesk as the upstream authorization server per MCP spec
      // 2025-06-18 (RFC 9728 protected-resource + RFC 8414 auth-server
      // metadata). MCP clients fetching /.well-known/oauth-protected-resource
      // discover Zendesk and complete the PKCE flow there directly.
      oauth: {
        enabled: true,
        protectedResource: {
          authorizationServers: [issuer],
          resource,
          bearerMethodsSupported: ['header'],
          scopesSupported: ['read', 'write'],
        },
        authorizationServer: {
          issuer,
          authorizationEndpoint: authorizeUrl,
          tokenEndpoint: tokenUrl,
          responseTypesSupported: ['code'],
          grantTypesSupported: ['authorization_code', 'refresh_token'],
          codeChallengeMethodsSupported: ['S256'],
          tokenEndpointAuthMethodsSupported: ['none'],
          scopesSupported: ['read', 'write'],
        },
      },
    };
  })();

  const server = new FastMCP<SessionAuth>({
    name: '@digital4better/zendesk-mcp-server',
    version: '0.1.0',
    health: { enabled: config.transport === 'http', path: '/healthz' },
    ...httpOptions,
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
        registerLeafTool(server, tool, config);
        registeredToolNames.push(tool.name);
      }
      break;
    }
    case 'namespace': {
      const grouped = groupByNamespace(filteredTools);
      for (const [namespace, tools] of grouped) {
        const label = NAMESPACE_LABELS[namespace];
        if (label) {
          registerProxyTool(server, label.toolName, label.title, tools, config);
          registeredToolNames.push(label.toolName);
        }
      }
      break;
    }
    case 'single': {
      registerProxyTool(server, 'zendesk', 'Zendesk', filteredTools, config);
      registeredToolNames.push('zendesk');
      break;
    }
  }

  console.error(`Registered ${filteredTools.length} tools in ${config.mode} mode`);
  return { server, registeredToolNames };
};
