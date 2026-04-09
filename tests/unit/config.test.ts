import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig } from '../../src/config';

describe('loadConfig', () => {
  beforeEach(() => {
    delete process.env['ZENDESK_SUBDOMAIN'];
    delete process.env['ZENDESK_OAUTH_CLIENT_ID'];
    delete process.env['ZENDESK_EMAIL'];
    delete process.env['ZENDESK_API_TOKEN'];
    delete process.env['LOG_LEVEL'];
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
});
