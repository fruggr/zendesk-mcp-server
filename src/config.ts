import * as z from 'zod/v4';

export const ToolMode = z.enum(['single', 'namespace', 'all']);
export type ToolMode = z.infer<typeof ToolMode>;

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

export const Namespace = z.enum(['tickets', 'help_center', 'users']);
export type Namespace = z.infer<typeof Namespace>;

export const Transport = z.enum(['stdio', 'http']);
export type Transport = z.infer<typeof Transport>;

export const ConfigSchema = z.object({
  subdomain: z.string().min(1, 'ZENDESK_SUBDOMAIN is required'),
  oauthClientId: z.string().min(1),
  zendeskEmail: z.string().optional(),
  zendeskApiToken: z.string().optional(),
  logLevel: LogLevel,
  mode: ToolMode,
  readOnly: z.boolean(),
  namespaces: z.array(Namespace).optional(),
  tools: z.array(z.string()).optional(),
  transport: Transport,
  host: z.string().min(1),
  port: z.number().int().min(0).max(65535),
  publicUrl: z.string().url().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

interface CliResult {
  subdomain?: string;
  mode?: string;
  readOnly?: boolean;
  namespaces?: string[];
  tools?: string[];
  logLevel?: string;
  transport?: string;
  host?: string;
  port?: number;
  publicUrl?: string;
}

const parseCliArgs = (args: string[]): CliResult => {
  const result: CliResult = {};
  let positionalIndex = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];

    if (arg === '--mode' && next) {
      result.mode = next;
      i++;
    } else if (arg === '--read-only') {
      result.readOnly = true;
    } else if (arg === '--namespace' && next) {
      result.namespaces = result.namespaces ?? [];
      result.namespaces.push(next);
      i++;
    } else if (arg === '--tool' && next) {
      result.tools = result.tools ?? [];
      result.tools.push(next);
      i++;
    } else if (arg === '--log-level' && next) {
      result.logLevel = next;
      i++;
    } else if (arg === '--transport' && next) {
      result.transport = next;
      i++;
    } else if (arg === '--host' && next) {
      result.host = next;
      i++;
    } else if (arg === '--port' && next) {
      result.port = Number.parseInt(next, 10);
      i++;
    } else if (arg === '--public-url' && next) {
      result.publicUrl = next;
      i++;
    } else if (!arg.startsWith('-') && positionalIndex === 0) {
      result.subdomain = arg;
      positionalIndex++;
    }
  }

  return result;
};

const parsePortEnv = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const loadConfig = (argv: string[] = process.argv.slice(2)): Config => {
  const cli = parseCliArgs(argv);

  const subdomain = cli.subdomain ?? process.env['ZENDESK_SUBDOMAIN'] ?? '';
  const oauthClientId =
    process.env['ZENDESK_OAUTH_CLIENT_ID'] ?? (subdomain ? `${subdomain}_zendesk` : '');

  const mode = cli.tools?.length ? 'all' : (cli.mode ?? 'namespace');

  const transport = cli.transport ?? process.env['TRANSPORT'] ?? 'stdio';
  const host = cli.host ?? process.env['HOST'] ?? '0.0.0.0';
  const port = cli.port ?? parsePortEnv(process.env['PORT']) ?? 3000;
  const publicUrl = cli.publicUrl ?? process.env['PUBLIC_URL'];

  const zendeskEmail = process.env['ZENDESK_EMAIL'];
  const zendeskApiToken = process.env['ZENDESK_API_TOKEN'];

  // API token auth in HTTP mode would expose the issuing user's full rights to
  // anyone reaching the server (shared static credential). Refuse only when
  // BOTH are set — a stray ZENDESK_EMAIL in the shell environment is harmless
  // by itself, and rejecting it would surprise operators who intended OAuth.
  if (transport === 'http' && zendeskEmail && zendeskApiToken) {
    throw new Error(
      'API token authentication (ZENDESK_EMAIL + ZENDESK_API_TOKEN) is not supported in HTTP mode. ' +
        'HTTP mode requires per-user OAuth 2.1 PKCE - unset these variables and configure your ' +
        'MCP client to perform the OAuth flow against Zendesk.',
    );
  }

  return ConfigSchema.parse({
    subdomain,
    oauthClientId,
    zendeskEmail,
    zendeskApiToken,
    logLevel: cli.logLevel ?? process.env['LOG_LEVEL'] ?? 'info',
    mode,
    readOnly: cli.readOnly ?? false,
    namespaces: cli.namespaces,
    tools: cli.tools,
    transport,
    host,
    port,
    publicUrl,
  });
};
