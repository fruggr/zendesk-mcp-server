import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema, DEFAULT_NAMESPACES, loadConfig, VALUE_FLAG_NAMES } from '../../src/config';

describe('loadConfig', () => {
  beforeEach(() => {
    delete process.env['ZENDESK_SUBDOMAIN'];
    delete process.env['ZENDESK_OAUTH_CLIENT_ID'];
    delete process.env['LOG_LEVEL'];
    delete process.env['TRANSPORT'];
    delete process.env['HOST'];
    delete process.env['PORT'];
    delete process.env['ZENDESK_OAUTH_CALLBACK_PORT'];
    delete process.env['HC_RESOURCE_SCHEME'];
  });

  it('parses subdomain from CLI positional arg', () => {
    const config = loadConfig(['mycompany']);
    expect(config.subdomain).toBe('mycompany');
  });

  // The flag tables are indexed by raw argv. Held in a plain object they would
  // resolve inherited keys, so a positional named after an Object.prototype
  // member matched a "flag" and was swallowed instead of read as the subdomain.
  it.each(['toString', 'constructor', 'valueOf'])(
    'takes %s as a positional subdomain, not a prototype key',
    (name) => {
      expect(loadConfig([name]).subdomain).toBe(name);
    },
  );

  // biome-ignore lint/suspicious/noTemplateCurlyInString: documents the literal default value ${subdomain}_zendesk
  it('defaults oauthClientId to ${subdomain}_zendesk', () => {
    const config = loadConfig(['mycompany']);
    expect(config.oauthClientId).toBe('mycompany_zendesk');
  });

  it('reads ZENDESK_OAUTH_CLIENT_ID from env', () => {
    process.env['ZENDESK_OAUTH_CLIENT_ID'] = 'custom_id';
    const config = loadConfig(['mycompany']);
    expect(config.oauthClientId).toBe('custom_id');
  });

  it('defaults to namespace mode', () => {
    const config = loadConfig(['mycompany']);
    expect(config.mode).toBe('namespace');
  });

  it('parses --mode flag', () => {
    const config = loadConfig(['mycompany', '--mode', 'single']);
    expect(config.mode).toBe('single');
  });

  it('forces mode all when --tool is specified', () => {
    const config = loadConfig(['mycompany', '--tool', 'get_ticket']);
    expect(config.mode).toBe('all');
    expect(config.tools).toEqual(['get_ticket']);
  });

  it('parses --read-only flag', () => {
    const config = loadConfig(['mycompany', '--read-only']);
    expect(config.readOnly).toBe(true);
  });

  it('enables the topology context by default', () => {
    const config = loadConfig(['mycompany']);
    expect(config.topology).toBe(true);
  });

  it('parses --no-topology flag', () => {
    const config = loadConfig(['mycompany', '--no-topology']);
    expect(config.topology).toBe(false);
  });

  it('enables the promoted-article pre-listing by default', () => {
    const config = loadConfig(['mycompany']);
    expect(config.promotedArticles).toBe(true);
  });

  it('parses --no-promoted-articles flag', () => {
    const config = loadConfig(['mycompany', '--no-promoted-articles']);
    expect(config.promotedArticles).toBe(false);
  });

  it('defaults dev mode to off', () => {
    const config = loadConfig(['mycompany']);
    expect(config.dev).toBe(false);
  });

  it('parses --dev flag', () => {
    const config = loadConfig(['mycompany', '--dev']);
    expect(config.dev).toBe(true);
  });

  it('parses multiple --namespace flags', () => {
    const config = loadConfig(['mycompany', '--namespace', 'tickets', '--namespace', 'users']);
    expect(config.namespaces).toEqual(['tickets', 'users']);
  });

  // Asserted exactly, not with toContain: the whole point of the default list
  // is which namespaces it leaves OUT, and a toContain-only test would pass
  // just as happily if a namespace were dropped from it.
  it('defaults to the agent namespaces, excluding the opt-in requests surface', () => {
    const config = loadConfig(['mycompany']);
    expect(config.namespaces).toEqual(['tickets', 'help_center', 'users']);
    expect(config.namespaces).not.toContain('requests');
  });

  it('exposes that same list as DEFAULT_NAMESPACES', () => {
    expect([...DEFAULT_NAMESPACES]).toEqual(['tickets', 'help_center', 'users']);
  });

  // The default must not survive an explicit --namespace: opting in to the
  // end-user surface has to mean *only* that surface, or a customer-facing
  // deployment would still carry the whole agent toolset.
  it('replaces the default set entirely when --namespace requests is passed', () => {
    const config = loadConfig(['mycompany', '--namespace', 'requests']);
    expect(config.namespaces).toEqual(['requests']);
  });

  it('accepts requests alongside another namespace', () => {
    const config = loadConfig([
      'mycompany',
      '--namespace',
      'requests',
      '--namespace',
      'help_center',
    ]);
    expect(config.namespaces).toEqual(['requests', 'help_center']);
  });

  it('does not print the tool surface unless asked', () => {
    expect(loadConfig(['mycompany']).printTools).toBe(false);
  });

  it('parses --print-tools flag', () => {
    expect(loadConfig(['mycompany', '--print-tools']).printTools).toBe(true);
  });

  it('reads subdomain from env when not in CLI', () => {
    process.env['ZENDESK_SUBDOMAIN'] = 'envcompany';
    const config = loadConfig([]);
    expect(config.subdomain).toBe('envcompany');
  });

  it('throws on missing subdomain, reporting only that', () => {
    // oauthClientId is derived from the subdomain, so an empty subdomain used to
    // fail twice — once for itself and once for a `''` client id the operator
    // never set. Only the actionable issue is reported now.
    expect(() => loadConfig([])).toThrow(/ZENDESK_SUBDOMAIN is required/);
    expect(() => loadConfig([])).not.toThrow(/oauthClientId/);
  });

  it('parses --log-level flag', () => {
    const config = loadConfig(['mycompany', '--log-level', 'debug']);
    expect(config.logLevel).toBe('debug');
  });

  describe('transport', () => {
    it('defaults to stdio', () => {
      const config = loadConfig(['mycompany']);
      expect(config.transport).toBe('stdio');
      expect(config.host).toBe('0.0.0.0');
      expect(config.port).toBe(3000);
    });

    it('parses --transport, --host, --port flags', () => {
      const config = loadConfig([
        'mycompany',
        '--transport',
        'http',
        '--host',
        '127.0.0.1',
        '--port',
        '8080',
      ]);
      expect(config.transport).toBe('http');
      expect(config.host).toBe('127.0.0.1');
      expect(config.port).toBe(8080);
    });

    it('reads TRANSPORT/HOST/PORT from env when CLI omits them', () => {
      process.env['TRANSPORT'] = 'http';
      process.env['HOST'] = '0.0.0.0';
      process.env['PORT'] = '4000';
      const config = loadConfig(['mycompany']);
      expect(config.transport).toBe('http');
      expect(config.host).toBe('0.0.0.0');
      expect(config.port).toBe(4000);
    });

    it('CLI overrides env for transport flags', () => {
      process.env['TRANSPORT'] = 'http';
      process.env['PORT'] = '4000';
      const config = loadConfig(['mycompany', '--transport', 'stdio', '--port', '5000']);
      expect(config.transport).toBe('stdio');
      expect(config.port).toBe(5000);
    });

    it('rejects --port values that are not strictly numeric', () => {
      expect(() => loadConfig(['mycompany', '--port', '8080abc'])).toThrow(/Invalid --port value/);
      expect(() => loadConfig(['mycompany', '--port', 'abc'])).toThrow();
    });

    it('rejects PORT env values that are not strictly numeric', () => {
      process.env['PORT'] = '8080abc';
      expect(() => loadConfig(['mycompany'])).toThrow(/Invalid PORT value/);
    });
  });

  describe('publicUrl', () => {
    beforeEach(() => {
      delete process.env['PUBLIC_URL'];
    });

    it('parses --public-url CLI flag', () => {
      const config = loadConfig([
        'mycompany',
        '--transport',
        'http',
        '--public-url',
        'https://mcp.example.com',
      ]);
      expect(config.publicUrl).toBe('https://mcp.example.com');
    });

    it('reads PUBLIC_URL from env', () => {
      process.env['PUBLIC_URL'] = 'https://mcp.example.com';
      const config = loadConfig(['mycompany', '--transport', 'http']);
      expect(config.publicUrl).toBe('https://mcp.example.com');
    });

    it('rejects a non-URL PUBLIC_URL', () => {
      process.env['PUBLIC_URL'] = 'not-a-url';
      expect(() => loadConfig(['mycompany', '--transport', 'http'])).toThrow();
    });

    it('defaults to undefined', () => {
      const config = loadConfig(['mycompany']);
      expect(config.publicUrl).toBeUndefined();
    });
  });

  describe('corsOrigins', () => {
    beforeEach(() => {
      delete process.env['CORS_ORIGIN'];
    });

    it('normalizes a trailing slash to the bare origin (browsers send no slash in Origin)', () => {
      const config = loadConfig(['mycompany', '--cors-origin', 'https://my-app.example.com/']);
      expect(config.corsOrigins).toEqual(['https://my-app.example.com']);
    });

    it('normalizes a URL with a path down to its origin', () => {
      process.env['CORS_ORIGIN'] = 'https://my-app.example.com/some/page';
      const config = loadConfig(['mycompany']);
      expect(config.corsOrigins).toEqual(['https://my-app.example.com']);
    });

    it('keeps an already-normalized origin untouched', () => {
      const config = loadConfig(['mycompany', '--cors-origin', 'https://my-app.example.com']);
      expect(config.corsOrigins).toEqual(['https://my-app.example.com']);
    });

    it('rejects values that are not URLs', () => {
      expect(() => loadConfig(['mycompany', '--cors-origin', 'not-a-url'])).toThrow();
    });
  });

  describe('hcResourceScheme', () => {
    it('defaults to zendesk-hc', () => {
      const config = loadConfig(['mycompany']);
      expect(config.hcResourceScheme).toBe('zendesk-hc');
    });

    it('parses --hc-resource-scheme flag', () => {
      const config = loadConfig(['mycompany', '--hc-resource-scheme', 'wiki']);
      expect(config.hcResourceScheme).toBe('wiki');
    });

    it('reads HC_RESOURCE_SCHEME from env', () => {
      process.env['HC_RESOURCE_SCHEME'] = 'docs';
      const config = loadConfig(['mycompany']);
      expect(config.hcResourceScheme).toBe('docs');
    });

    it('prefers --hc-resource-scheme over the env var', () => {
      process.env['HC_RESOURCE_SCHEME'] = 'docs';
      const config = loadConfig(['mycompany', '--hc-resource-scheme', 'wiki']);
      expect(config.hcResourceScheme).toBe('wiki');
    });

    it('accepts any RFC 3986 scheme: letter then letters, digits, "+", "-", "."', () => {
      expect(
        loadConfig(['mycompany', '--hc-resource-scheme', 'fruggr-wiki']).hcResourceScheme,
      ).toBe('fruggr-wiki');
      expect(loadConfig(['mycompany', '--hc-resource-scheme', 'z6+x.y-w']).hcResourceScheme).toBe(
        'z6+x.y-w',
      );
    });

    it('rejects a scheme carrying the "://" separator (strict bare scheme, no normalization)', () => {
      expect(() => loadConfig(['mycompany', '--hc-resource-scheme', 'wiki://'])).toThrow(
        /HC_RESOURCE_SCHEME|--hc-resource-scheme/,
      );
    });

    it('rejects schemes that are not RFC 3986 conformant', () => {
      for (const bad of ['Wiki', '-wiki', '1wiki', 'wi ki']) {
        expect(() => loadConfig(['mycompany', '--hc-resource-scheme', bad])).toThrow();
      }
    });

    it('reports only the format error for format-rejected values, not the WHATWG-special one', () => {
      let thrown: unknown;
      try {
        loadConfig(['mycompany', '--hc-resource-scheme', 'Wiki']);
      } catch (error) {
        thrown = error;
      }
      expect(String(thrown)).toContain('RFC 3986');
      expect(String(thrown)).not.toContain('WHATWG-special');
    });

    it('rejects WHATWG-special schemes whose URL normalization would make the resource unreadable', () => {
      for (const special of ['http', 'https', 'ws', 'wss', 'ftp', 'file']) {
        expect(() => loadConfig(['mycompany', '--hc-resource-scheme', special])).toThrow(
          /WHATWG-special/,
        );
      }
    });

    // Deliberate spec change (issue #174): this used to assert that an empty
    // HC_RESOURCE_SCHEME meant "unset", matching the PORT-style envs. That
    // convention hid a broken deployment — `--hc-resource-scheme "$SCHEME"` with
    // SCHEME unset booted on the default scheme while runbooks expected the
    // branded one. Empty now fails at startup, naming the variable.
    it('rejects an empty HC_RESOURCE_SCHEME env', () => {
      process.env['HC_RESOURCE_SCHEME'] = '';
      expect(() => loadConfig(['mycompany'])).toThrow(/Empty HC_RESOURCE_SCHEME\./);
    });

    it('rejects an invalid HC_RESOURCE_SCHEME env value', () => {
      process.env['HC_RESOURCE_SCHEME'] = 'wiki://';
      expect(() => loadConfig(['mycompany'])).toThrow(/HC_RESOURCE_SCHEME|--hc-resource-scheme/);
    });
  });

  describe('callbackPort', () => {
    it('leaves callbackPort undefined by default', () => {
      const config = loadConfig(['mycompany']);
      expect(config.callbackPort).toBeUndefined();
    });

    it('parses --callback-port flag', () => {
      const config = loadConfig(['mycompany', '--callback-port', '51000']);
      expect(config.callbackPort).toBe(51000);
    });

    it('reads ZENDESK_OAUTH_CALLBACK_PORT from env', () => {
      process.env['ZENDESK_OAUTH_CALLBACK_PORT'] = '52000';
      const config = loadConfig(['mycompany']);
      expect(config.callbackPort).toBe(52000);
    });

    it('prefers --callback-port over the env var', () => {
      process.env['ZENDESK_OAUTH_CALLBACK_PORT'] = '52000';
      const config = loadConfig(['mycompany', '--callback-port', '51000']);
      expect(config.callbackPort).toBe(51000);
    });

    it('rejects a callback port outside the TCP range', () => {
      expect(() => loadConfig(['mycompany', '--callback-port', '70000'])).toThrow();
    });

    it('rejects --callback-port values that are not strictly numeric', () => {
      // Same strictness as --port: Number.parseInt would accept '51000abc'.
      expect(() => loadConfig(['mycompany', '--callback-port', '51000abc'])).toThrow(
        /Invalid --callback-port value/,
      );
    });

    it('rejects ZENDESK_OAUTH_CALLBACK_PORT env values that are not strictly numeric', () => {
      process.env['ZENDESK_OAUTH_CALLBACK_PORT'] = '52000abc';
      expect(() => loadConfig(['mycompany'])).toThrow(/Invalid ZENDESK_OAUTH_CALLBACK_PORT value/);
    });
  });

  // A value-taking flag whose value is missing or empty used to be dropped
  // silently, so the server booted with defaults and nothing in the logs pointed
  // at the cause (issue #174). Every shape below must now fail at startup.
  describe('strict CLI parsing', () => {
    // Driven by the exported flag list, not a hand-picked sample: a new flag is
    // covered the moment it is added to CLI_OPTIONS, so the guarantee cannot
    // drift per-flag the way the old one-branch-per-flag chain did.
    const valueFlags = [...VALUE_FLAG_NAMES];

    it('covers every value-taking flag declared in CLI_OPTIONS', () => {
      // Guards the parametrised cases below against silently shrinking to zero.
      expect(valueFlags).toHaveLength(11);
    });

    it.each(valueFlags)('rejects %s as the last argument (value forgotten)', (flag) => {
      expect(() => loadConfig(['mycompany', flag])).toThrow();
    });

    it.each(valueFlags)('rejects %s followed by an empty value', (flag) => {
      expect(() => loadConfig(['mycompany', flag, ''])).toThrow(
        new RegExp(`Empty value for \\${flag}\\.`),
      );
    });

    it.each(valueFlags)('rejects %s in the --flag= form with nothing after it', (flag) => {
      expect(() => loadConfig(['mycompany', `${flag}=`])).toThrow(
        new RegExp(`Empty value for \\${flag}\\.`),
      );
    });

    it('rejects a value-taking flag that would swallow the next flag', () => {
      // Used to yield host === '--read-only' with readOnly silently false: on
      // stdio `host` is ignored entirely, so a server meant to be read-only
      // exposed its write tools with no diagnostic at all.
      expect(() => loadConfig(['mycompany', '--host', '--read-only'])).toThrow();
    });

    it('rejects an unknown flag instead of silently ignoring it', () => {
      expect(() => loadConfig(['mycompany', '--hc-ressource-scheme', 'wiki'])).toThrow();
    });

    it('does not let a typo-d flag turn its value into the subdomain', () => {
      // `--hc-ressource-scheme wiki mycompany` used to boot against subdomain
      // `wiki`, dropping `mycompany` — the wrong Zendesk tenant, silently.
      expect(() => loadConfig(['--hc-ressource-scheme', 'wiki', 'mycompany'])).toThrow();
    });

    it('does not echo the value of an unknown --flag=value argument', () => {
      // Same no-echo policy as parsePort: an Error.message here bubbles up to
      // the `console.error('Fatal error:', error)` in src/index.ts.
      expect(() => loadConfig(['mycompany', '--oauth-token=s3cr3t'])).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('s3cr3t') }),
      );
    });

    it('reports the empty flag rather than a misleading missing-subdomain error', () => {
      // The empty value used to fall through to the positional-subdomain branch,
      // consuming it so `mycompany` was dropped and startup failed with
      // `ZENDESK_SUBDOMAIN is required` — naming the wrong knob entirely.
      expect(() => loadConfig(['--hc-resource-scheme', '', 'mycompany'])).toThrow(
        /Empty value for --hc-resource-scheme\./,
      );
      expect(() => loadConfig(['--hc-resource-scheme', '', 'mycompany'])).not.toThrow(
        /ZENDESK_SUBDOMAIN is required/,
      );
    });

    it('rejects a value handed to a standalone flag', () => {
      expect(() => loadConfig(['mycompany', '--read-only=false'])).toThrow();
    });

    it('rejects a second positional instead of silently dropping it', () => {
      expect(() => loadConfig(['mycompany', 'othercompany'])).toThrow(
        /Expected one positional argument \(the subdomain\), got 2\./,
      );
    });

    it('counts the positionals it actually got', () => {
      // Pins the count to the real number rather than a fixed string, so the
      // operator can tell two stray arguments from one.
      expect(() => loadConfig(['mycompany', 'second', 'third'])).toThrow(/got 3\./);
    });

    it('rejects a space-separated list handed to a repeatable flag', () => {
      // The natural wrong guess for a `multiple: true` flag. Used to boot against
      // subdomain `help_center` with only the `tickets` namespace registered and
      // `mycompany` dropped: the wrong tenant AND a narrowed tool surface, with
      // no diagnostic — the same class of silent misconfiguration as issue #174.
      expect(() => loadConfig(['--namespace', 'tickets', 'help_center', 'mycompany'])).toThrow(
        /Expected one positional argument \(the subdomain\), got 2\./,
      );
      expect(() => loadConfig(['mycompany', '--tool', 'get_ticket', 'list_tickets'])).toThrow(
        /Expected one positional argument/,
      );
    });

    it('points at the repeated-flag form rather than just refusing', () => {
      expect(() => loadConfig(['mycompany', 'extra'])).toThrow(
        /--namespace tickets --namespace help_center/,
      );
    });

    it('does not echo the extra positional values', () => {
      // Same no-echo policy as parsePort: a stray argument can be a tenant name.
      expect(() => loadConfig(['mycompany', 's3cr3t-tenant'])).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('s3cr3t-tenant') }),
      );
    });

    it('still accepts every flag with a proper value', () => {
      const config = loadConfig([
        'mycompany',
        '--mode',
        'all',
        '--read-only',
        '--namespace',
        'tickets',
        '--hc-resource-scheme',
        'wiki',
        '--log-level',
        'debug',
        '--transport',
        'http',
        '--host',
        '127.0.0.1',
        '--port',
        '8080',
        '--public-url',
        'https://mcp.example.com',
        '--cors-origin',
        'https://app.example.com',
        '--callback-port',
        '51000',
        '--dev',
      ]);
      expect(config.subdomain).toBe('mycompany');
      expect(config.readOnly).toBe(true);
      expect(config.hcResourceScheme).toBe('wiki');
      expect(config.port).toBe(8080);
      expect(config.callbackPort).toBe(51000);
      expect(config.corsOrigins).toEqual(['https://app.example.com']);
      expect(config.dev).toBe(true);
    });

    it('accepts the --flag=value form', () => {
      const config = loadConfig(['mycompany', '--mode=all', '--hc-resource-scheme=wiki']);
      expect(config.mode).toBe('all');
      expect(config.hcResourceScheme).toBe('wiki');
    });

    it('takes a bare argument that collides with an Object.prototype key as the subdomain', () => {
      // The old parser indexed argv against Maps precisely to avoid inherited
      // keys being resolved; parseArgs collects positionals into an array, so
      // they are never lookup keys at all.
      const config = loadConfig(['toString']);
      expect(config.subdomain).toBe('toString');
    });
  });

  // An empty environment variable is an operator error, not "unset": `FOO=` in a
  // compose file, or `FOO="$BAR"` with BAR unset, both arrive as ''. Applying the
  // default there hides a broken deployment (issue #174).
  describe('empty environment variables', () => {
    beforeEach(() => {
      delete process.env['PUBLIC_URL'];
      delete process.env['CORS_ORIGIN'];
    });

    it.each([
      'ZENDESK_OAUTH_CLIENT_ID',
      'LOG_LEVEL',
      'TRANSPORT',
      'HOST',
      'PORT',
      'PUBLIC_URL',
      'ZENDESK_OAUTH_CALLBACK_PORT',
      'HC_RESOURCE_SCHEME',
    ])('rejects an empty %s', (name) => {
      process.env[name] = '';
      expect(() => loadConfig(['mycompany'])).toThrow(new RegExp(`Empty ${name}\\.`));
    });

    it('rejects an empty ZENDESK_SUBDOMAIN', () => {
      // No positional here: the subdomain is the one knob a CLI argument would
      // override, and an overridden variable is never consulted (see below).
      process.env['ZENDESK_SUBDOMAIN'] = '';
      expect(() => loadConfig([])).toThrow(/Empty ZENDESK_SUBDOMAIN\./);
    });

    it('ignores an empty variable that a CLI flag overrides', () => {
      // Deliberate: validation applies to the value that is actually consulted.
      // CLI > env is the documented precedence, so an empty variable the flag
      // shadows is dead config, not a misconfiguration worth refusing to boot
      // over — `--port 8080` alongside a stray `PORT=` in a compose file is a
      // normal deployment, not a broken one.
      process.env['PORT'] = '';
      process.env['HC_RESOURCE_SCHEME'] = '';
      const config = loadConfig([
        'mycompany',
        '--port',
        '8080',
        '--hc-resource-scheme',
        'wiki',
        '--transport',
        'http',
      ]);
      expect(config.port).toBe(8080);
      expect(config.hcResourceScheme).toBe('wiki');
    });

    it('ignores an empty ZENDESK_SUBDOMAIN that the positional argument overrides', () => {
      // The positional subdomain is not a flag, but it shadows the variable the
      // same way, so the same rule applies: the variable is never consulted and
      // its emptiness is dead config rather than a reason to refuse to boot.
      process.env['ZENDESK_SUBDOMAIN'] = '';
      expect(loadConfig(['mycompany']).subdomain).toBe('mycompany');
    });

    it('keeps CORS_ORIGIN tolerant of an empty value', () => {
      // A list variable: `CORS_ORIGIN=` means "no extra origins", which is a
      // normal way to write it in a compose file. The built-in allowlist (major
      // web MCP clients + localhost) applies regardless.
      process.env['CORS_ORIGIN'] = '';
      const config = loadConfig(['mycompany']);
      expect(config.corsOrigins).toEqual([]);
    });

    it('still applies defaults when the variables are unset rather than empty', () => {
      const config = loadConfig(['mycompany']);
      expect(config.hcResourceScheme).toBe('zendesk-hc');
      expect(config.port).toBe(3000);
      expect(config.callbackPort).toBeUndefined();
      expect(config.logLevel).toBe('info');
    });
  });
});

// The default lives in the schema rather than in loadConfig because the
// integration harness parses a Config directly; these assertions pin that.
describe('ConfigSchema namespaces', () => {
  const parse = (namespaces?: unknown) =>
    ConfigSchema.parse({
      subdomain: 'mycompany',
      oauthClientId: 'mycompany_zendesk',
      logLevel: 'info',
      mode: 'all',
      readOnly: false,
      transport: 'stdio',
      host: '127.0.0.1',
      port: 0,
      ...(namespaces === undefined ? {} : { namespaces }),
    });

  it('applies the default when the field is absent, not only via loadConfig', () => {
    expect(parse().namespaces).toEqual(['tickets', 'help_center', 'users']);
  });

  // loadConfig passes printTools explicitly, so its schema default is only ever
  // reached through this parse path -- which the integration harness uses.
  it('defaults printTools to false when the field is absent', () => {
    expect(parse().printTools).toBe(false);
  });

  it('rejects an empty array instead of treating it as "every namespace"', () => {
    // filterTools guards on `?.length`, so [] would mean "no filter" and would
    // quietly expose the opt-in requests surface. Refuse it at parse time.
    expect(() => parse([])).toThrow();
  });

  it('rejects an unknown namespace', () => {
    expect(() => parse(['nope'])).toThrow();
  });

  it('accepts requests as a namespace', () => {
    expect(parse(['requests']).namespaces).toEqual(['requests']);
  });

  it('does not mutate DEFAULT_NAMESPACES when a parsed config is edited', () => {
    const config = parse();
    config.namespaces.push('requests');
    expect([...DEFAULT_NAMESPACES]).toEqual(['tickets', 'help_center', 'users']);
  });
});
