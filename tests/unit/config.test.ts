import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

describe('loadConfig', () => {
  beforeEach(() => {
    delete process.env['ZENDESK_SUBDOMAIN'];
    delete process.env['ZENDESK_OAUTH_CLIENT_ID'];
    delete process.env['LOG_LEVEL'];
    delete process.env['TRANSPORT'];
    delete process.env['HOST'];
    delete process.env['PORT'];
    delete process.env['ZENDESK_OAUTH_CALLBACK_PORT'];
  });

  it('parses subdomain from CLI positional arg', () => {
    const config = loadConfig(['mycompany']);
    expect(config.subdomain).toBe('mycompany');
  });

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

  it('enables the article resources by default', () => {
    const config = loadConfig(['mycompany']);
    expect(config.articleResources).toBe(true);
  });

  it('parses --no-article-resources flag', () => {
    const config = loadConfig(['mycompany', '--no-article-resources']);
    expect(config.articleResources).toBe(false);
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

  it('reads subdomain from env when not in CLI', () => {
    process.env['ZENDESK_SUBDOMAIN'] = 'envcompany';
    const config = loadConfig([]);
    expect(config.subdomain).toBe('envcompany');
  });

  it('throws on missing subdomain', () => {
    expect(() => loadConfig([])).toThrow();
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
});
