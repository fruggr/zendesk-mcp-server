import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config';
import {
  aggregateAnnotations,
  buildOperationList,
  createMcpServer,
  summarizeDescription,
} from '../../src/server';
import type { ToolAnnotations } from '../../src/tools/definitions';

const ann = (overrides: Partial<ToolAnnotations> = {}): ToolAnnotations => ({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
  ...overrides,
});

type RegisteredTool = { description?: string; annotations?: ToolAnnotations };
const introspect = (server: ReturnType<typeof createMcpServer>): Record<string, RegisteredTool> =>
  (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;

const baseConfig: Config = {
  subdomain: 'testsubdomain',
  oauthClientId: 'test_zendesk',
  logLevel: 'info',
  mode: 'all',
  readOnly: false,
};

const getToken = () => 'test-token';

describe('createMcpServer', () => {
  it('creates a server in all mode', () => {
    const server = createMcpServer({ ...baseConfig, mode: 'all' }, getToken);
    expect(server).toBeDefined();
  });

  it('creates a server in namespace mode', () => {
    const server = createMcpServer({ ...baseConfig, mode: 'namespace' }, getToken);
    expect(server).toBeDefined();
  });

  it('creates a server in single mode', () => {
    const server = createMcpServer({ ...baseConfig, mode: 'single' }, getToken);
    expect(server).toBeDefined();
  });

  it('creates a server with readOnly filter', () => {
    const server = createMcpServer({ ...baseConfig, readOnly: true }, getToken);
    expect(server).toBeDefined();
  });

  it('creates a server with namespace filter', () => {
    const server = createMcpServer({ ...baseConfig, namespaces: ['tickets'] }, getToken);
    expect(server).toBeDefined();
  });

  it('creates a server with tool filter', () => {
    const server = createMcpServer(
      { ...baseConfig, mode: 'all', tools: ['get_ticket', 'get_current_user'] },
      getToken,
    );
    expect(server).toBeDefined();
  });

  it('registers a single read-only proxy when namespace and read-only are combined', () => {
    const server = createMcpServer(
      {
        ...baseConfig,
        mode: 'namespace',
        namespaces: ['help_center'],
        readOnly: true,
      },
      getToken,
    );

    const registered = introspect(server);
    const names = Object.keys(registered);

    expect(names).toEqual(['zendesk_help_center']);

    const description = registered['zendesk_help_center']?.description ?? '';
    expect(description).not.toMatch(/\(write\)/);
    expect(description).toContain('search_articles');
    expect(description).toContain('get_article');
    expect(description).not.toContain('create_article');
    expect(description).not.toContain('update_article');
  });

  it('marks read-only proxies with readOnlyHint=true and a [RO] description prefix', () => {
    const server = createMcpServer(
      {
        ...baseConfig,
        mode: 'namespace',
        namespaces: ['help_center'],
        readOnly: true,
      },
      getToken,
    );

    const proxy = introspect(server)['zendesk_help_center'];
    expect(proxy?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(proxy?.description ?? '').toMatch(/^\[RO\] /);
  });

  it('flags a mixed namespace proxy as destructive but not read-only', () => {
    const server = createMcpServer(
      { ...baseConfig, mode: 'namespace', namespaces: ['tickets'] },
      getToken,
    );

    const proxy = introspect(server)['zendesk_tickets'];
    expect(proxy?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(proxy?.description ?? '').not.toMatch(/^\[RO\] /);
  });

  it('aggregates the single-proxy annotations across every namespace', () => {
    const server = createMcpServer({ ...baseConfig, mode: 'single' }, getToken);

    const proxy = introspect(server)['zendesk'];
    expect(proxy?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });
});

describe('aggregateAnnotations', () => {
  it('returns readOnly + idempotent when every op is read-only and idempotent', () => {
    const result = aggregateAnnotations([
      { annotations: ann({ readOnlyHint: true, idempotentHint: true }) },
      { annotations: ann({ readOnlyHint: true, idempotentHint: true }) },
    ]);
    expect(result).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('drops readOnly as soon as one op is write', () => {
    const result = aggregateAnnotations([
      { annotations: ann({ readOnlyHint: true, idempotentHint: true }) },
      { annotations: ann({ readOnlyHint: false, idempotentHint: false }) },
    ]);
    expect(result.readOnlyHint).toBe(false);
  });

  it('raises destructive as soon as one op is destructive', () => {
    const result = aggregateAnnotations([
      { annotations: ann({ readOnlyHint: true }) },
      { annotations: ann({ destructiveHint: true }) },
    ]);
    expect(result.destructiveHint).toBe(true);
  });

  it('always reports openWorldHint=true (this server always hits Zendesk)', () => {
    const result = aggregateAnnotations([{ annotations: ann({ openWorldHint: false }) }]);
    expect(result.openWorldHint).toBe(true);
  });

  it('drops idempotentHint as soon as one op is non-idempotent', () => {
    const result = aggregateAnnotations([
      { annotations: ann({ readOnlyHint: true, idempotentHint: true }) },
      { annotations: ann({ readOnlyHint: false, idempotentHint: false }) },
    ]);
    expect(result.idempotentHint).toBe(false);
  });

  it('handles an empty tool list with the every/some vacuous defaults', () => {
    const result = aggregateAnnotations([]);
    expect(result).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
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
