import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config';
import { filterTools } from '../../src/routing/registry';
import { buildOperationList, createMcpServer, summarizeDescription } from '../../src/server';
import { createAllTools } from '../../src/tools/index';

const baseConfig: Config = {
  subdomain: 'testsubdomain',
  oauthClientId: 'test_zendesk',
  logLevel: 'info',
  mode: 'all',
  readOnly: false,
  transport: 'stdio',
  host: '0.0.0.0',
  port: 3000,
};

const getToken = () => 'test-token';

describe('createMcpServer', () => {
  it('creates a server in all mode', () => {
    const { server, registeredToolNames } = createMcpServer(
      { ...baseConfig, mode: 'all' },
      getToken,
    );
    expect(server).toBeDefined();
    expect(registeredToolNames.length).toBeGreaterThan(0);
  });

  it('creates a server in namespace mode', () => {
    const { server, registeredToolNames } = createMcpServer(
      { ...baseConfig, mode: 'namespace' },
      getToken,
    );
    expect(server).toBeDefined();
    // namespace mode produces one proxy per surviving namespace
    expect(registeredToolNames).toContain('zendesk_tickets');
    expect(registeredToolNames).toContain('zendesk_help_center');
    expect(registeredToolNames).toContain('zendesk_users');
  });

  it('creates a server in single mode', () => {
    const { server, registeredToolNames } = createMcpServer(
      { ...baseConfig, mode: 'single' },
      getToken,
    );
    expect(server).toBeDefined();
    expect(registeredToolNames).toEqual(['zendesk']);
  });

  it('creates a server with readOnly filter', () => {
    const { server } = createMcpServer({ ...baseConfig, readOnly: true }, getToken);
    expect(server).toBeDefined();
  });

  it('creates a server with namespace filter', () => {
    const { registeredToolNames } = createMcpServer(
      { ...baseConfig, namespaces: ['tickets'] },
      getToken,
    );
    // mode=all + namespace=tickets → only tickets-namespace leaf tools
    expect(registeredToolNames).toContain('get_ticket');
    expect(registeredToolNames).not.toContain('get_article');
  });

  it('creates a server with tool filter', () => {
    const { registeredToolNames } = createMcpServer(
      { ...baseConfig, mode: 'all', tools: ['get_ticket', 'get_current_user'] },
      getToken,
    );
    expect(registeredToolNames.sort()).toEqual(['get_current_user', 'get_ticket']);
  });

  it('registers a single read-only proxy when namespace and read-only are combined', () => {
    const config: Config = {
      ...baseConfig,
      mode: 'namespace',
      namespaces: ['help_center'],
      readOnly: true,
    };
    const { registeredToolNames } = createMcpServer(config, getToken);
    expect(registeredToolNames).toEqual(['zendesk_help_center']);

    // The proxy's description is built deterministically from the same
    // filtered tool list — verify via the exported helper rather than
    // poking fastmcp internals.
    const filtered = filterTools(createAllTools({ subdomain: 'x', getToken }), {
      readOnly: config.readOnly,
      namespaces: config.namespaces,
    });
    const description = buildOperationList(filtered);
    expect(description).not.toMatch(/\(write\)/);
    expect(description).toContain('search_articles');
    expect(description).toContain('get_article');
    expect(description).not.toContain('create_article');
    expect(description).not.toContain('update_article');
  });

  it('exposes the OAuth discovery config in HTTP mode', () => {
    const { server } = createMcpServer({ ...baseConfig, transport: 'http' }, getToken);
    const oauth = server.options.oauth;
    expect(oauth?.enabled).toBe(true);
    expect(oauth?.protectedResource?.authorizationServers).toContain(
      `https://${baseConfig.subdomain}.zendesk.com`,
    );
    expect(oauth?.authorizationServer?.codeChallengeMethodsSupported).toContain('S256');
  });
});

describe('summarizeDescription', () => {
  it('returns the first sentence when the description has multiple sentences', () => {
    expect(summarizeDescription('First. Second. Third.')).toBe('First.');
  });

  it('returns the whole string when there is no sentence delimiter', () => {
    expect(summarizeDescription('One sentence only')).toBe('One sentence only');
  });

  it('preserves trailing period on the kept sentence', () => {
    expect(summarizeDescription('Do X. Then Y.')).toBe('Do X.');
  });

  it('handles an empty string', () => {
    expect(summarizeDescription('')).toBe('');
  });
});

describe('buildOperationList', () => {
  const sample = [
    {
      name: 'get_thing',
      description: 'Retrieve a thing by ID. Lots more context that should be trimmed.',
      readOnly: true,
    },
    {
      name: 'update_thing',
      description: 'Update a thing. Prefer update_thing_section for targeted edits.',
      readOnly: false,
    },
  ];

  it('uses only the first sentence of each description', () => {
    const out = buildOperationList(sample);
    expect(out).toContain('Retrieve a thing by ID.');
    expect(out).not.toContain('Lots more context');
    expect(out).toContain('Update a thing.');
    expect(out).not.toContain('Prefer update_thing_section');
  });

  it('flags write operations with a (write) marker', () => {
    const out = buildOperationList(sample);
    expect(out).toMatch(/update_thing\*\*.*\(write\)/);
    expect(out).not.toMatch(/get_thing\*\*.*\(write\)/);
  });
});
