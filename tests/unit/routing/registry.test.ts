import { describe, it, expect } from 'vitest';
import { filterTools, groupByNamespace } from '../../../src/routing/registry';
import { createAllTools } from '../../../src/tools/index';
import type { ToolContext } from '../../../src/tools/definitions';

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'token' };
const allTools = createAllTools(ctx);

describe('filterTools', () => {
  it('returns all tools when no filters', () => {
    const filtered = filterTools(allTools, { readOnly: false });
    expect(filtered).toHaveLength(allTools.length);
  });

  it('filters to readOnly tools', () => {
    const filtered = filterTools(allTools, { readOnly: true });
    expect(filtered.length).toBeLessThan(allTools.length);
    expect(filtered.every((t) => t.readOnly)).toBe(true);
  });

  it('filters by namespace', () => {
    const filtered = filterTools(allTools, { readOnly: false, namespaces: ['tickets'] });
    expect(filtered.every((t) => t.namespace === 'tickets')).toBe(true);
    expect(filtered.length).toBeGreaterThan(0);
  });

  it('filters by multiple namespaces', () => {
    const filtered = filterTools(allTools, {
      readOnly: false,
      namespaces: ['tickets', 'users'],
    });
    const namespaces = new Set(filtered.map((t) => t.namespace));
    expect(namespaces).toEqual(new Set(['tickets', 'users']));
  });

  it('filters by tool names', () => {
    const filtered = filterTools(allTools, {
      readOnly: false,
      tools: ['get_ticket', 'get_current_user'],
    });
    expect(filtered).toHaveLength(2);
    expect(filtered.map((t) => t.name).sort()).toEqual(['get_current_user', 'get_ticket']);
  });

  it('combines readOnly + namespace', () => {
    const filtered = filterTools(allTools, { readOnly: true, namespaces: ['help_center'] });
    expect(filtered.every((t) => t.readOnly && t.namespace === 'help_center')).toBe(true);
  });
});

describe('groupByNamespace', () => {
  it('groups tools by namespace', () => {
    const grouped = groupByNamespace(allTools);
    expect(grouped.has('tickets')).toBe(true);
    expect(grouped.has('help_center')).toBe(true);
    expect(grouped.has('users')).toBe(true);
  });

  it('has correct tool counts per namespace', () => {
    const grouped = groupByNamespace(allTools);
    const ticketCount = grouped.get('tickets')?.length ?? 0;
    const hcCount = grouped.get('help_center')?.length ?? 0;
    const userCount = grouped.get('users')?.length ?? 0;
    expect(ticketCount).toBe(10); // 9 ticket tools + 1 search
    expect(hcCount).toBe(17);
    expect(userCount).toBe(5);
  });
});
