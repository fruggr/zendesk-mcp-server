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
  logLevel: LogLevel,
  mode: ToolMode,
  readOnly: z.boolean(),
  namespaces: z.array(Namespace).optional(),
  tools: z.array(z.string()).optional(),
  /**
   * Whether to expose the Help Center structural context (the `instructions`
   * blob + the topology resource, default `zendesk-hc://topology`). On by
   * default; an operator
   * disables it server-wide with `--no-topology` (e.g. on a very large Help
   * Center, or when the context is unwanted). Only ever active when the
   * `help_center` namespace itself is active.
   */
  topology: z.boolean().default(true),
  /**
   * Whether to PRE-LIST the promoted ("featured") Help Center articles: the
   * `<scheme>://article/{id}` resource's `list` callback (which scans `/articles`
   * to enumerate the promoted set for `resources/list`) AND the
   * `list_promoted_articles` tool. On by default; an operator disables the
   * pre-listing with `--no-promoted-articles` (e.g. on a very large Help Center
   * where scanning is costly) so the server issues zero preloading requests. This
   * does NOT disable reading a known article by id (`<scheme>://article/{id}` stays
   * registered) — that is cheap and on-demand. Only ever active when the
   * `help_center` namespace itself is active.
   */
  promotedArticles: z.boolean().default(true),
  /**
   * URI scheme of the Help Center MCP resources (today the topology resource,
   * `<scheme>://topology`). Defaults to `zendesk-hc`; a deployer can brand it
   * (`--hc-resource-scheme wiki` / `HC_RESOURCE_SCHEME=wiki`). Strictly a bare
   * RFC 3986 scheme — clients parse resource URIs with WHATWG `URL`, so a
   * non-conformant scheme would surface as a broken resource at runtime;
   * reject it at config parse time instead. ASCII-only message, value not
   * echoed (same policy as parsePort below).
   */
  hcResourceScheme: z
    .string()
    .regex(/^[a-z][a-z0-9+.-]*$/, {
      message:
        'Invalid HC_RESOURCE_SCHEME / --hc-resource-scheme value. Expected a bare RFC 3986 scheme: a lowercase letter followed by lowercase letters, digits, "+", "-" or "." (no "://").',
      // Stop here on a format failure so the WHATWG-special refinement below
      // does not pile a misleading second message onto e.g. `Wiki`.
      abort: true,
    })
    // WHATWG "special" schemes (http, https, ws, wss, ftp, file) serialize
    // with a trailing slash (`new URL('http://x').toString()` === 'http://x/'),
    // so the SDK's read handler — which normalizes the requested URI through
    // `URL` before its exact-string registry lookup — would list the resource
    // but never find it on read. Require the actual URI to round-trip.
    .refine(
      (scheme) => {
        const uri = `${scheme}://topology`;
        try {
          return new URL(uri).toString() === uri;
        } catch {
          return false;
        }
      },
      {
        message:
          'Invalid HC_RESOURCE_SCHEME / --hc-resource-scheme value. WHATWG-special schemes (http, https, ws, wss, ftp, file) do not survive URL normalization and would make the resource unreadable; pick a custom scheme such as "wiki".',
      },
    )
    .default('zendesk-hc'),
  /**
   * Dev-only (stdio): expose the `reload_tools` tool, which re-imports the tool
   * modules from source and re-registers them on the live session on demand, so
   * tool code edited during a dev cycle takes effect without a restart. CLI-only
   * and off by default — it has no place in a deployed server. Fuller notes in
   * the "Dev mode" section of docs/configuration.md.
   */
  dev: z.boolean().default(false),
  transport: Transport,
  host: z.string().min(1),
  port: z.number().int().min(0).max(65535),
  publicUrl: z.string().url().optional(),
  /**
   * Additional browser origins allowed by CORS in HTTP mode. The default
   * allowlist (the major web MCP clients + localhost-any-port for dev) is
   * always applied; this list extends it. Native MCP clients (Claude
   * Desktop, Claude Code CLI, Cursor, VS Code, Zed…) are unaffected
   * because they send no Origin header.
   */
  corsOrigins: z
    .array(
      z
        .string()
        .url()
        // Browsers send `Origin` with no trailing slash or path, and the CORS
        // allowlist matches by strict equality. Normalize the configured value
        // to its origin so `https://app.example.com/` (natural when
        // copy-pasting a URL) still matches at runtime.
        .transform((value) => new URL(value).origin)
        .refine((origin) => origin !== 'null', {
          message: 'CORS origin must be an http(s) URL with a host',
        }),
    )
    .default([]),
  callbackPort: z.number().int().min(1).max(65535).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

interface CliResult {
  subdomain?: string;
  mode?: string;
  readOnly?: boolean;
  namespaces?: string[];
  tools?: string[];
  topology?: boolean;
  promotedArticles?: boolean;
  hcResourceScheme?: string;
  dev?: boolean;
  logLevel?: string;
  transport?: string;
  host?: string;
  port?: number;
  publicUrl?: string;
  corsOrigins?: string[];
  callbackPort?: number;
}

// Number.parseInt('8080abc', 10) === 8080 — silently accepts a numeric
// prefix. Validate strictly so malformed values fail loudly instead. Range
// checks (0 vs 1 minimum etc.) stay in ConfigSchema, the single authority.
//
// The error intentionally does NOT echo the offending value: when `label`
// names a variable CodeQL's heuristics treat as sensitive (anything with
// "OAUTH" / "TOKEN" / etc. in the name, like ZENDESK_OAUTH_CALLBACK_PORT),
// reflecting `raw` into a thrown Error.message that bubbles up to the
// `console.error('Fatal error:', error)` in src/index.ts gets flagged as
// `js/clear-text-logging`. The label alone tells the operator which knob is
// wrong; they can re-read their env / CLI to see what they actually set.
const parsePort = (raw: string, label: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${label} value. Expected an integer 0-65535.`);
  }
  return Number(raw);
};

const parsePortEnv = (raw: string | undefined, label: string): number | undefined =>
  raw === undefined || raw === '' ? undefined : parsePort(raw, label);

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
    } else if (arg === '--no-topology') {
      result.topology = false;
    } else if (arg === '--no-promoted-articles') {
      result.promotedArticles = false;
    } else if (arg === '--hc-resource-scheme' && next) {
      result.hcResourceScheme = next;
      i++;
    } else if (arg === '--dev') {
      result.dev = true;
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
      result.port = parsePort(next, '--port');
      i++;
    } else if (arg === '--public-url' && next) {
      result.publicUrl = next;
      i++;
    } else if (arg === '--cors-origin' && next) {
      result.corsOrigins = result.corsOrigins ?? [];
      result.corsOrigins.push(next);
      i++;
    } else if (arg === '--callback-port' && next) {
      result.callbackPort = parsePort(next, '--callback-port');
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

  const transport = cli.transport ?? process.env['TRANSPORT'] ?? 'stdio';
  const host = cli.host ?? process.env['HOST'] ?? '0.0.0.0';
  const port = cli.port ?? parsePortEnv(process.env['PORT'], 'PORT') ?? 3000;
  const publicUrl = cli.publicUrl ?? process.env['PUBLIC_URL'];

  // CORS allowlist extension: CLI flags first, then comma-separated env var.
  // The defaults (major web MCP clients + localhost-any-port) are baked into
  // the HTTP transport — this list ADDS to them, never replaces them.
  const corsFromEnv = (process.env['CORS_ORIGIN'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const corsOrigins = [...(cli.corsOrigins ?? []), ...corsFromEnv];

  const callbackPort =
    cli.callbackPort ??
    parsePortEnv(process.env['ZENDESK_OAUTH_CALLBACK_PORT'], 'ZENDESK_OAUTH_CALLBACK_PORT');

  // `|| undefined`: an empty env means unset (same convention as parsePortEnv),
  // letting the schema default (`zendesk-hc`) apply; format is schema-validated.
  const hcResourceScheme = cli.hcResourceScheme ?? (process.env['HC_RESOURCE_SCHEME'] || undefined);

  return ConfigSchema.parse({
    subdomain,
    oauthClientId,
    logLevel: cli.logLevel ?? process.env['LOG_LEVEL'] ?? 'info',
    mode,
    readOnly: cli.readOnly ?? false,
    namespaces: cli.namespaces,
    tools: cli.tools,
    topology: cli.topology ?? true,
    promotedArticles: cli.promotedArticles ?? true,
    hcResourceScheme,
    dev: cli.dev ?? false,
    transport,
    host,
    port,
    publicUrl,
    corsOrigins,
    callbackPort,
  });
};
