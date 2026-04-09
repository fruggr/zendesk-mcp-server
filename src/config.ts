import * as z from 'zod/v4';

export const ToolMode = z.enum(['single', 'namespace', 'all']);
export type ToolMode = z.infer<typeof ToolMode>;

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

export const Namespace = z.enum(['tickets', 'help_center', 'users']);
export type Namespace = z.infer<typeof Namespace>;

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
});

export type Config = z.infer<typeof ConfigSchema>;

interface CliResult {
  subdomain?: string;
  mode?: string;
  readOnly?: boolean;
  namespaces?: string[];
  tools?: string[];
  logLevel?: string;
}

const parseCliArgs = (args: string[]): CliResult => {
  const result: CliResult = {};
  let positionalIndex = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
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
    } else if (!arg.startsWith('-') && positionalIndex === 0) {
      result.subdomain = arg;
      positionalIndex++;
    }
  }

  return result;
};

export const loadConfig = (argv: string[] = process.argv.slice(2)): Config => {
  const cli = parseCliArgs(argv);

  const subdomain = cli.subdomain ?? process.env['ZENDESK_SUBDOMAIN'] ?? '';
  const oauthClientId =
    process.env['ZENDESK_OAUTH_CLIENT_ID'] ?? (subdomain ? `${subdomain}_zendesk` : '');

  const mode = cli.tools?.length ? 'all' : (cli.mode ?? 'namespace');

  return ConfigSchema.parse({
    subdomain,
    oauthClientId,
    zendeskEmail: process.env['ZENDESK_EMAIL'],
    zendeskApiToken: process.env['ZENDESK_API_TOKEN'],
    logLevel: cli.logLevel ?? process.env['LOG_LEVEL'] ?? 'info',
    mode,
    readOnly: cli.readOnly ?? false,
    namespaces: cli.namespaces,
    tools: cli.tools,
  });
};
