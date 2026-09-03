import { describe, expect, it } from 'vitest';
import { Namespace } from '../../../src/config';
import { filterTools, groupByNamespace, NAMESPACE_LABELS } from '../../../src/routing/registry';
import type { ToolContext } from '../../../src/tools/definitions';
import { createAllTools } from '../../../src/tools/index';

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
    expect(filtered.map((t) => t.name).sort((a, b) => a.localeCompare(b))).toEqual([
      'get_current_user',
      'get_ticket',
    ]);
  });

  it('combines readOnly + namespace', () => {
    const filtered = filterTools(allTools, { readOnly: true, namespaces: ['help_center'] });
    expect(filtered.every((t) => t.readOnly && t.namespace === 'help_center')).toBe(true);
  });
});

describe('filterTools promotedArticles gate', () => {
  it('keeps list_promoted_articles when the flag is unset or true', () => {
    const unset = filterTools(allTools, { readOnly: false });
    const on = filterTools(allTools, { readOnly: false, promotedArticles: true });
    expect(unset.some((t) => t.name === 'list_promoted_articles')).toBe(true);
    expect(on.some((t) => t.name === 'list_promoted_articles')).toBe(true);
  });

  it('drops only that tool when the flag is false', () => {
    const off = filterTools(allTools, { readOnly: false, promotedArticles: false });
    expect(off.some((t) => t.name === 'list_promoted_articles')).toBe(false);
    expect(off).toHaveLength(allTools.length - 1);
    // Reading a known article by id is unaffected; only the scan-backed
    // listing goes away.
    expect(off.some((t) => t.name === 'get_article')).toBe(true);
  });
});

describe('groupByNamespace', () => {
  it('groups tools by namespace', () => {
    const grouped = groupByNamespace(allTools);
    expect(grouped.has('tickets')).toBe(true);
    expect(grouped.has('requests')).toBe(true);
    expect(grouped.has('help_center')).toBe(true);
    expect(grouped.has('users')).toBe(true);
  });

  it('has correct tool counts per namespace', () => {
    const grouped = groupByNamespace(allTools);
    const ticketCount = grouped.get('tickets')?.length ?? 0;
    const hcCount = grouped.get('help_center')?.length ?? 0;
    const userCount = grouped.get('users')?.length ?? 0;
    const requestCount = grouped.get('requests')?.length ?? 0;
    expect(ticketCount).toBe(18); // 17 ticket tools + 1 search
    expect(hcCount).toBe(29);
    expect(userCount).toBe(5);
    expect(requestCount).toBe(7);
  });
});

// Asserted as a whole rather than probed key by key. These strings are the
// client-visible proxy tool names and titles: a typo or an emptied value is a
// broken tool surface, and nothing else in the suite reads the titles at all.
describe('NAMESPACE_LABELS', () => {
  it('maps every namespace to its proxy name and title', () => {
    expect(NAMESPACE_LABELS).toEqual({
      tickets: { toolName: 'zendesk_tickets', title: 'Zendesk Tickets' },
      help_center: { toolName: 'zendesk_help_center', title: 'Zendesk Help Center' },
      users: { toolName: 'zendesk_users', title: 'Zendesk Users' },
      requests: { toolName: 'zendesk_requests', title: 'Zendesk Requests' },
    });
  });

  // The type already makes an incomplete literal a compile error; this catches
  // the reverse drift, a label left behind for a namespace that no longer exists.
  it('covers exactly the Namespace enum, with no extra keys', () => {
    expect(Object.keys(NAMESPACE_LABELS).sort()).toEqual([...Namespace.options].sort());
  });
});
