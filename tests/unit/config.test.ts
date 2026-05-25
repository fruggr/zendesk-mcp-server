import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

describe('loadConfig', () => {
  beforeEach(() => {
    delete process.env['ZENDESK_SUBDOMAIN'];
    delete process.env['ZENDESK_OAUTH_CLIENT_ID'];
    delete process.env['ZENDESK_EMAIL'];
    delete process.env['ZENDESK_API_TOKEN'];
    delete process.env['LOG_LEVEL'];
    delete process.env['TRANSPORT'];
    delete process.env['HOST'];
    delete process.env['PORT'];
  });

  it('parses subdomain from CLI positional arg', () => {
    const config = loadConfig(['mycompany']);
    expect(config.subdomain).toBe('mycompany');
  });

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

  it('captures zendeskEmail and zendeskApiToken from env', () => {
    process.env['ZENDESK_EMAIL'] = 'a@b.com';
    process.env['ZENDESK_API_TOKEN'] = 'tok';
    const config = loadConfig(['mycompany']);
    expect(config.zendeskEmail).toBe('a@b.com');
    expect(config.zendeskApiToken).toBe('tok');
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

    it('refuses API token credentials in HTTP mode', () => {
      process.env['ZENDESK_EMAIL'] = 'a@b.com';
      process.env['ZENDESK_API_TOKEN'] = 'tok';
      expect(() => loadConfig(['mycompany', '--transport', 'http'])).toThrow(
        /API token authentication.*not supported in HTTP mode/,
      );
    });

    it('accepts API token credentials in stdio mode', () => {
      process.env['ZENDESK_EMAIL'] = 'a@b.com';
      process.env['ZENDESK_API_TOKEN'] = 'tok';
      const config = loadConfig(['mycompany']);
      expect(config.transport).toBe('stdio');
      expect(config.zendeskApiToken).toBe('tok');
    });
  });
});
