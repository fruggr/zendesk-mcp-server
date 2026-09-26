import { type ParseArgsConfig, parseArgs } from 'node:util';
import * as z from 'zod/v4';

export const ToolMode = z.enum(['single', 'namespace', 'all']);
export type ToolMode = z.infer<typeof ToolMode>;

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevel>;

export const Namespace = z.enum(['tickets', 'help_center', 'users', 'requests']);
export type Namespace = z.infer<typeof Namespace>;

/**
 * Namespaces exposed when the operator passes no `--namespace` flag.
 *
 * Deliberately NOT every member of the enum: the end-user `requests` surface
 * is opt-in, because under an agent token part of it silently misbehaves
 * rather than failing -- `solved: true` returns 200 and changes nothing, and
 * `required_in_portal` validation is not applied to agents. Registering it for
 * every agent install would ship an operation that reports success on a no-op.
 * Secondarily, an agent's tool list and context budget stay unchanged.
 */
export const DEFAULT_NAMESPACES: readonly Namespace[] = ['tickets', 'help_center', 'users'];

export const Transport = z.enum(['stdio', 'http']);
export type Transport = z.infer<typeof Transport>;

export const ConfigSchema = z.object({
  subdomain: z.string().min(1, 'ZENDESK_SUBDOMAIN is required'),
  oauthClientId: z.string().min(1),
  logLevel: LogLevel,
  mode: ToolMode,
  readOnly: z.boolean(),
  /**
   * Active namespaces, defaulting to DEFAULT_NAMESPACES rather than everything.
   *
   * The default lives HERE, not in `loadConfig`: the integration harness builds
   * its Config through `ConfigSchema.parse` and never calls `loadConfig`, so a
   * default applied there would leave `requests` visible to every scenario and
   * absent in production.
   *
   * `.min(1)` rejects an explicit `[]`, which `filterTools` reads as no filter
   * at all (it guards on `?.length`) and would expose the opt-in namespace.
   */
  namespaces: z
    .array(Namespace)
    .min(1)
    .default([...DEFAULT_NAMESPACES]),
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
    // WHATWG "special" schemes (http, https, ws, wss, ftp, file) serialize with a
    // trailing slash, so the SDK's read handler — which normalizes through `URL`
    // before its exact-string registry lookup — would list the resource and never
    // find it on read. Require the URI to round-trip.
    .refine(
      (scheme) => {
        // No try/catch: `abort: true` above means only /^[a-z][a-z0-9+.-]*$/ gets
        // here, which is WHATWG's own scheme grammar, so `new URL` always parses it.
        const uri = `${scheme}://topology`;
        return new URL(uri).toString() === uri;
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
  /**
   * Print the tool surface the current flags resolve to, then exit without
   * starting a server or touching the network. `--print-tools` exists because
   * the surface is shaped by three independent knobs (`--namespace` / `--tool`
   * pick the inventory, `--mode` packages it, `--read-only` narrows it) and
   * their combination is easier to read off a listing than to predict.
   */
  printTools: z.boolean().default(false),
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
  /**
   * HTTP only: the authorization server's master secret (`OAUTH_MASTER_SECRET`),
   * or a file holding it. Both optional: when absent, one is generated and
   * persisted in the config dir. Belongs to this server, not to Zendesk, hence
   * no `ZENDESK_` prefix. Validated (length, base64) where it is used, so a
   * value never reaches a schema error message.
   */
  oauthMasterSecret: z.string().optional(),
  oauthMasterSecretFile: z.string().min(1).optional(),
  /** HTTP only: the grant store URI; defaults to a file in the config dir. */
  oauthStore: z.string().url().optional(),
  /** HTTP only: a package exporting a third-party Keyv store for `oauthStore`. */
  oauthStoreAdapter: z.string().min(1).optional(),
  /** HTTP only: CIMD client ids added to the consent-skip allowlist. */
  oauthTrustedClients: z.array(z.string().url()).default([]),
  /** HTTP only: whether the built-in allowlist (claude.ai, ChatGPT) applies. */
  defaultTrustedClients: z.boolean().default(true),
});

export type Config = z.infer<typeof ConfigSchema>;

interface CliResult {
  // Explicitly `| undefined` so the parser can assign the first positional
  // unconditionally: `exactOptionalPropertyTypes` would otherwise force a guard
  // that reads as behaviour but only ever satisfies the type checker.
  subdomain?: string | undefined;
  mode?: string;
  readOnly?: boolean;
  namespaces?: string[];
  tools?: string[];
  topology?: boolean;
  promotedArticles?: boolean;
  hcResourceScheme?: string;
  dev?: boolean;
  printTools?: boolean;
  logLevel?: string;
  transport?: string;
  host?: string;
  port?: number;
  publicUrl?: string;
  corsOrigins?: string[];
  callbackPort?: number;
  oauthMasterSecretFile?: string;
  oauthStore?: string;
  oauthStoreAdapter?: string;
  oauthTrustedClients?: string[];
  defaultTrustedClients?: boolean;
}

// Number.parseInt('8080abc', 10) === 8080 — a numeric prefix passes silently, so
// validate strictly. Range checks stay in ConfigSchema, the single authority.
//
// The error must not echo the value: reflecting `raw` from a sensitive-looking
// variable (ZENDESK_OAUTH_CALLBACK_PORT) into a message that reaches
// `console.error` trips CodeQL's js/clear-text-logging. The label names the knob.
const DIGITS_ONLY = /^\d+$/;

const parsePort = (raw: string, label: string): number => {
  if (!DIGITS_ONLY.test(raw)) {
    throw new Error(`Invalid ${label} value. Expected an integer 0-65535.`);
  }
  return Number(raw);
};

const parsePortEnv = (raw: string | undefined, label: string): number | undefined =>
  raw === undefined ? undefined : parsePort(raw, label);

// An empty variable is a misconfiguration, not "unset": `FOO=` and `FOO="$BAR"`
// with BAR unset both reach us as ''. Defaulting there boots a config that
// disagrees with the deployment's intent, so fail naming it (#174). CORS_ORIGIN
// is exempt — as a list, empty means "no extra origins".
const requireNonEmptyEnv = (name: string): string | undefined => {
  const raw = process.env[name];
  if (raw === '') {
    throw new Error(`Empty ${name}. Set it to a value, or unset it entirely.`);
  }
  return raw;
};

// The whole CLI surface as one declarative table: `parseArgs` derives the
// unknown-flag, missing-value and stray-value rejections from it, so those
// guarantees cannot drift per flag. Adding a flag is one entry here.
const CLI_OPTIONS = {
  mode: { type: 'string' },
  namespace: { type: 'string', multiple: true },
  tool: { type: 'string', multiple: true },
  'log-level': { type: 'string' },
  'hc-resource-scheme': { type: 'string' },
  transport: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  'public-url': { type: 'string' },
  'cors-origin': { type: 'string', multiple: true },
  'callback-port': { type: 'string' },
  'oauth-master-secret-file': { type: 'string' },
  'oauth-store': { type: 'string' },
  'oauth-store-adapter': { type: 'string' },
  'oauth-trusted-client': { type: 'string', multiple: true },
  'no-default-trusted-clients': { type: 'boolean' },
  'read-only': { type: 'boolean' },
  'no-topology': { type: 'boolean' },
  'no-promoted-articles': { type: 'boolean' },
  dev: { type: 'boolean' },
  'print-tools': { type: 'boolean' },
} as const satisfies ParseArgsConfig['options'];

// The value-taking subset, spelled as they appear on the command line. Exported
// so scripts/mcp-live.ts can tell `all` in `--mode all` from a positional
// subdomain without maintaining its own copy of the list.
export const VALUE_FLAG_NAMES: ReadonlySet<string> = new Set(
  Object.entries(CLI_OPTIONS)
    .filter(([, spec]) => spec.type === 'string')
    .map(([name]) => `--${name}`),
);

// Which CliResult field each flag feeds, for the ones whose value passes through
// untouched. `--port` / `--callback-port` are handled separately because they go
// through parsePort, and the standalone flags below carry no value at all.
const FIELD_BY_FLAG = new Map<string, keyof CliResult>([
  ['mode', 'mode'],
  ['namespace', 'namespaces'],
  ['tool', 'tools'],
  ['log-level', 'logLevel'],
  ['hc-resource-scheme', 'hcResourceScheme'],
  ['transport', 'transport'],
  ['host', 'host'],
  ['public-url', 'publicUrl'],
  ['cors-origin', 'corsOrigins'],
  ['oauth-master-secret-file', 'oauthMasterSecretFile'],
  ['oauth-store', 'oauthStore'],
  ['oauth-store-adapter', 'oauthStoreAdapter'],
  ['oauth-trusted-client', 'oauthTrustedClients'],
]);

// Standalone flags set a fixed value, which is why they cannot go through
// FIELD_BY_FLAG: `--no-topology` being present means `topology: false`.
const STANDALONE_EFFECTS = new Map<string, Partial<CliResult>>([
  ['read-only', { readOnly: true }],
  ['no-topology', { topology: false }],
  ['no-promoted-articles', { promotedArticles: false }],
  ['dev', { dev: true }],
  ['print-tools', { printTools: true }],
  ['no-default-trusted-clients', { defaultTrustedClients: false }],
]);

const parseCliArgs = (args: string[]): CliResult => {
  // `strict` (the default) is what makes a malformed invocation fail at startup.
  // Node's messages already name the offending flag and never echo the value
  // after an `=`, so they are surfaced as-is rather than re-wrapped.
  const { values, positionals } = parseArgs({
    args,
    options: CLI_OPTIONS,
    allowPositionals: true,
  });

  // Dropping a second positional silently would be the worst outcome here:
  // `--namespace tickets help_center mycompany` takes `help_center` as the
  // subdomain and discards `mycompany` — wrong tenant, narrowed tool surface, no
  // diagnostic. Counted, never echoed.
  if (positionals.length > 1) {
    throw new Error(
      `Expected one positional argument (the subdomain), got ${positionals.length}. ` +
        'A repeatable flag has to be repeated (--namespace tickets --namespace ' +
        'help_center); it does not take a space-separated list.',
    );
  }

  // Built up locally and returned once: `parseCliArgs` stays a pure function of
  // its argv, and the accumulator never escapes. A `reduce` spreading `acc` per
  // flag would read as more immutable but is what `noAccumulatingSpread`
  // (enabled in biome.json) rejects, for its O(n^2) copying.
  const result: CliResult = { subdomain: positionals[0] };

  // parseArgs only reports flags that were actually passed, so iterating its
  // output visits exactly the operator's invocation.
  for (const [flag, value] of Object.entries(values)) {
    // The one shape parseArgs accepts: an empty value, from `--mode ""` or
    // `--mode=`. That is exactly what a shell hands over for an unset variable,
    // and it used to be dropped and then consumed as the positional subdomain,
    // so startup failed with a misleading `ZENDESK_SUBDOMAIN is required`.
    if (Array.isArray(value) ? value.includes('') : value === '') {
      throw new Error(`Empty value for --${flag}. Provide a value, or omit the flag.`);
    }

    const effect = STANDALONE_EFFECTS.get(flag);
    if (effect) {
      Object.assign(result, effect);
      continue;
    }

    const field = FIELD_BY_FLAG.get(flag);
    if (field) Object.assign(result, { [field]: value });
  }

  // Ports last, so an empty value is rejected above before parsePort sees it.
  if (values.port !== undefined) result.port = parsePort(values.port, '--port');
  if (values['callback-port'] !== undefined) {
    result.callbackPort = parsePort(values['callback-port'], '--callback-port');
  }

  return result;
};

const splitList = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

interface TransportSettings {
  transport: string;
  host: string;
  port: number;
  publicUrl: string | undefined;
  corsOrigins: string[];
}

// The five HTTP-transport knobs, resolved together because they share one
// precedence rule (CLI flag > env var > built-in default) and one audience —
// they are the surface documented in docs/http-deployment.md. stdio ignores all
// of them.
const resolveTransportSettings = (cli: CliResult): TransportSettings => {
  // The defaults (major web MCP clients + localhost-any-port) live in the HTTP
  // transport — this list ADDS to them, never replaces them. Read directly, not
  // through requireNonEmptyEnv: as a list, an empty CORS_ORIGIN means "no extra
  // origins" rather than a misconfiguration.
  const corsFromEnv = splitList(process.env['CORS_ORIGIN']);

  return {
    transport: cli.transport ?? requireNonEmptyEnv('TRANSPORT') ?? 'stdio',
    host: cli.host ?? requireNonEmptyEnv('HOST') ?? '0.0.0.0',
    port: cli.port ?? parsePortEnv(requireNonEmptyEnv('PORT'), 'PORT') ?? 3000,
    publicUrl: cli.publicUrl ?? requireNonEmptyEnv('PUBLIC_URL'),
    corsOrigins: [...(cli.corsOrigins ?? []), ...corsFromEnv],
  };
};

// The authorization server's knobs (HTTP only), same precedence as the
// transport settings. The secret has no CLI flag on purpose: a value on the
// command line leaks into process listings, so it is an env var or a file.
const resolveOAuthServerSettings = (cli: CliResult) => ({
  oauthMasterSecret: requireNonEmptyEnv('OAUTH_MASTER_SECRET'),
  oauthMasterSecretFile:
    cli.oauthMasterSecretFile ?? requireNonEmptyEnv('OAUTH_MASTER_SECRET_FILE'),
  oauthStore: cli.oauthStore ?? requireNonEmptyEnv('OAUTH_STORE'),
  oauthStoreAdapter: cli.oauthStoreAdapter ?? requireNonEmptyEnv('OAUTH_STORE_ADAPTER'),
  oauthTrustedClients: [
    ...(cli.oauthTrustedClients ?? []),
    ...splitList(process.env['OAUTH_TRUSTED_CLIENTS']),
  ],
  defaultTrustedClients: cli.defaultTrustedClients,
});

export const loadConfig = (argv: string[] = process.argv.slice(2)): Config => {
  const cli = parseCliArgs(argv);

  const subdomain = cli.subdomain ?? requireNonEmptyEnv('ZENDESK_SUBDOMAIN') ?? '';
  // No empty-subdomain special case: a missing subdomain already fails the
  // schema on its own, and derived-but-unused `_zendesk` here keeps that report
  // down to the one issue the operator can act on.
  const oauthClientId = requireNonEmptyEnv('ZENDESK_OAUTH_CLIENT_ID') ?? `${subdomain}_zendesk`;

  const mode = cli.tools?.length ? 'all' : (cli.mode ?? 'namespace');

  // `filterTools` ANDs the namespace and tool filters, so keeping the default
  // set here would make `--tool list_requests` resolve to nothing: the tool
  // exists, its namespace is not in the default. An explicit `--tool` without
  // `--namespace` therefore opens the namespace filter and narrows by tool.
  const namespaces = cli.namespaces ?? (cli.tools?.length ? [...Namespace.options] : undefined);

  const callbackPort =
    cli.callbackPort ??
    parsePortEnv(requireNonEmptyEnv('ZENDESK_OAUTH_CALLBACK_PORT'), 'ZENDESK_OAUTH_CALLBACK_PORT');

  // Unset leaves this undefined so the schema default (`zendesk-hc`) applies;
  // empty is rejected by requireNonEmptyEnv. Format is schema-validated.
  const hcResourceScheme = cli.hcResourceScheme ?? requireNonEmptyEnv('HC_RESOURCE_SCHEME');

  return ConfigSchema.parse({
    subdomain,
    oauthClientId,
    logLevel: cli.logLevel ?? requireNonEmptyEnv('LOG_LEVEL') ?? 'info',
    mode,
    readOnly: cli.readOnly ?? false,
    namespaces,
    tools: cli.tools,
    topology: cli.topology ?? true,
    promotedArticles: cli.promotedArticles ?? true,
    hcResourceScheme,
    dev: cli.dev ?? false,
    printTools: cli.printTools ?? false,
    callbackPort,
    ...resolveTransportSettings(cli),
    ...resolveOAuthServerSettings(cli),
  });
};
