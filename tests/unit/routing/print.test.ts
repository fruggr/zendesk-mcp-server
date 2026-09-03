import { describe, expect, it } from 'vitest';
import { type Config, ConfigSchema } from '../../../src/config';
import { renderToolSurface } from '../../../src/routing/print';
import type { ToolContext, ToolDefinition } from '../../../src/tools/definitions';
import { createAllTools } from '../../../src/tools/index';

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'token' };
const allTools = createAllTools(ctx);

const makeConfig = (overrides: Partial<Config> = {}): Config =>
  ConfigSchema.parse({
    subdomain: 'testsubdomain',
    oauthClientId: 'testsubdomain_zendesk',
    logLevel: 'info',
    mode: 'namespace',
    readOnly: false,
    transport: 'stdio',
    host: '127.0.0.1',
    port: 0,
    ...overrides,
  });

// A minimal pair of definitions, so the mode branches can be asserted on an
// exact string without the assertion churning every time a real tool is added.
const stub = (name: string, namespace: ToolDefinition['namespace'], readOnly: boolean) =>
  ({ name, namespace, readOnly }) as ToolDefinition;

const twoTools = [stub('read_thing', 'tickets', true), stub('write_thing', 'tickets', false)];

describe('renderToolSurface', () => {
  it('states the knobs in force on the first line', () => {
    const out = renderToolSurface(makeConfig(), allTools);
    expect(out.split('\n')[0]).toBe(
      'Mode: namespace | Namespaces: tickets, help_center, users | Read-only: no',
    );
  });

  it('reports read-only mode in the header', () => {
    const out = renderToolSurface(makeConfig({ readOnly: true }), allTools);
    expect(out.split('\n')[0]).toContain('Read-only: yes');
  });

  it('names the --tool filter in the header only when one is set', () => {
    expect(renderToolSurface(makeConfig(), allTools)).not.toContain('Tool filter');
    const out = renderToolSurface(makeConfig({ mode: 'all', tools: ['get_ticket'] }), allTools);
    expect(out).toContain('Tool filter: get_ticket');
  });

  // Two entries, so the separator itself is asserted and not just the presence
  // of the names.
  it('comma-separates several --tool filters', () => {
    const out = renderToolSurface(
      makeConfig({ mode: 'all', tools: ['get_ticket', 'list_tickets'] }),
      allTools,
    );
    expect(out.split('\n')[0]).toBe(
      'Mode: all | Namespaces: tickets, help_center, users | Read-only: no' +
        ' | Tool filter: get_ticket, list_tickets',
    );
  });

  it('renders namespace mode as one proxy per namespace with its operations', () => {
    const out = renderToolSurface(makeConfig({ namespaces: ['tickets'] }), twoTools);
    expect(out).toBe(
      [
        'Mode: namespace | Namespaces: tickets | Read-only: no',
        '',
        '1 proxy tool(s) exposed:',
        '  zendesk_tickets',
        '    - read_thing',
        '    - write_thing (write)',
      ].join('\n'),
    );
  });

  it('prefixes a read-only proxy with [RO], as the proxy description does', () => {
    const out = renderToolSurface(
      makeConfig({ namespaces: ['tickets'], readOnly: true }),
      twoTools,
    );
    expect(out).toContain('  [RO] zendesk_tickets');
    // The write tool is filtered out before the proxy is described.
    expect(out).not.toContain('write_thing');
  });

  it('renders single mode as one proxy wrapping every operation', () => {
    const out = renderToolSurface(
      makeConfig({ mode: 'single', namespaces: ['tickets'] }),
      twoTools,
    );
    expect(out).toBe(
      [
        'Mode: single | Namespaces: tickets | Read-only: no',
        '',
        '1 proxy tool exposed, wrapping 2 operation(s):',
        '  zendesk',
        '    - read_thing',
        '    - write_thing (write)',
      ].join('\n'),
    );
  });

  it('renders all mode as a flat list marking the write tools', () => {
    const out = renderToolSurface(makeConfig({ mode: 'all', namespaces: ['tickets'] }), twoTools);
    expect(out).toBe(
      [
        'Mode: all | Namespaces: tickets | Read-only: no',
        '',
        '2 tool(s) exposed individually:',
        '  read_thing',
        '  write_thing (write)',
      ].join('\n'),
    );
  });

  it('says so plainly when the filters leave nothing', () => {
    const out = renderToolSurface(makeConfig({ mode: 'all', tools: ['no_such_tool'] }), allTools);
    expect(out).toContain('No tools exposed. Check --namespace / --tool / --read-only.');
  });

  // The whole point of the flag: seeing that the end-user surface is opt-in
  // without booting a server.
  it('shows no requests proxy under the default namespaces', () => {
    const out = renderToolSurface(makeConfig(), allTools);
    expect(out).not.toContain('zendesk_requests');
  });

  it('rejects a mode outside the union', () => {
    const bogus = { ...makeConfig(), mode: 'nope' } as unknown as Config;
    expect(() => renderToolSurface(bogus, twoTools)).toThrow('Unsupported tool mode: nope');
  });
});
