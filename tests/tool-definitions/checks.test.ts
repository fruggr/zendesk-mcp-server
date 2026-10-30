import type { ToolDefinition } from 'mcp-tdqs';
import { describe, expect, it } from 'vitest';
import {
  namesASibling,
  reviewToolDefinitions,
  undescribedProperties,
  unknownToolReferences,
} from './checks';

const READ = { readOnlyHint: true, destructiveHint: false };

const tool = (name: string, description: string, extra: object = {}): ToolDefinition => ({
  name,
  title: null,
  description,
  annotations: READ,
  inputSchema: { type: 'object', properties: {} },
  outputSchema: null,
  ...extra,
});

describe('undescribedProperties', () => {
  it('reports every undescribed property, at any depth, with its path', () => {
    expect(
      undescribedProperties({
        properties: {
          top: {},
          described: { description: 'x' },
          blank: { description: '  ' },
          list: {
            description: 'a list',
            items: { properties: { id: {}, value: { description: 'v' } } },
          },
          union: {
            description: 'one of',
            anyOf: [{ properties: { a: {} } }, { oneOf: [{ properties: { b: {} } }] }],
            allOf: [{ properties: { c: {} } }],
          },
          obj: { description: 'o', properties: { inner: {} } },
        },
      }),
    ).toEqual(['top', 'blank', 'list[].id', 'union.a', 'union.b', 'union.c', 'obj.inner']);
  });

  it('also walks records, tuples, $defs and boolean property schemas', () => {
    expect(
      undescribedProperties({
        properties: {
          map: { description: 'by key', additionalProperties: { properties: { id: {} } } },
          closed: { description: 'no extras', additionalProperties: false },
          pair: { description: 'two', prefixItems: [{ properties: { a: {} } }], items: false },
          legacy: { description: 'tuple', items: [{ properties: { b: {} } }] },
          anything: true,
        },
        $defs: { Node: { properties: { c: {}, d: { description: 'd' } } } },
      }),
    ).toEqual(['map{}.id', 'pair[].a', 'legacy[].b', 'anything', '$defs.Node.c']);
  });

  it('has nothing to say about a schema-less tool', () => {
    expect(undescribedProperties(undefined)).toEqual([]);
  });
});

describe('namesASibling', () => {
  const names = ['get_user', 'search_users', 'search'];

  it('counts a snake_case sibling named as a whole word', () => {
    expect(namesASibling(tool('search_users', 'Prefer get_user for one id.'), names)).toBe(true);
  });

  it('does not count the tool naming itself, nor a longer word containing a sibling', () => {
    expect(namesASibling(tool('get_user', 'Use get_user or get_users_x.'), names)).toBe(false);
  });

  it('counts a one-word sibling only in backticks', () => {
    expect(namesASibling(tool('search_users', 'Uses Zendesk search syntax.'), names)).toBe(false);
    expect(namesASibling(tool('search_users', 'Prefer `search` across types.'), names)).toBe(true);
  });
});

describe('unknownToolReferences', () => {
  const tools = [
    tool('get_user', 'Get a user.', {
      inputSchema: { properties: { get_all: { description: 'flag' } } },
    }),
    tool('list_users', 'List users; see get_user, get_all, get_userz and per_page.'),
  ];

  it('flags tool-shaped words that are neither a tool nor a parameter', () => {
    const [, listUsers] = tools;
    expect(listUsers && unknownToolReferences(tools)(listUsers)).toEqual(['get_userz']);
  });
});

describe('reviewToolDefinitions', () => {
  it('gates on tdqs errors and on its own checks, never on the non-gating rules', () => {
    const report = reviewToolDefinitions('demo', {
      tools: [
        tool('get_item', 'get_item'),
        tool('delete_item', 'Delete an item. Returns nothing; see get_itemz.', {
          annotations: { readOnlyHint: true, destructiveHint: true },
          inputSchema: { properties: { id: {} } },
        }),
      ],
    });
    expect(report.problems.map(({ check, tool: name }) => `${check} ${name}`)).toEqual([
      'tdqs/tautological-description get_item',
      'tdqs/undocumented-parameters delete_item',
      'undescribed-property delete_item',
      'annotation-conflict delete_item',
      'unknown-tool-reference delete_item',
    ]);
  });

  it('reports hashes, sizes and sibling naming per tool, and shadow candidates apart', () => {
    const report = reviewToolDefinitions('demo', {
      tools: [
        tool('ping', 'Check the server answers. Prefer get_item to read data.'),
        tool('get_item', 'Read one item by id and return it whole.', {
          inputSchema: {
            properties: {
              a: { description: 'first key' },
              b: { description: 'second key' },
              c: { description: 'third key' },
              d: { description: 'fourth key' },
            },
            required: ['a', 'b', 'c', 'd'],
          },
        }),
      ],
    });
    expect(report.problems).toEqual([]);
    expect(report.shadowCandidates).toEqual([{ tool: 'get_item', cheaperSibling: 'ping' }]);
    expect(report.tools.map(({ name, namesASibling: n }) => [name, n])).toEqual([
      ['ping', true],
      ['get_item', false],
    ]);
    expect(report.tools[0]?.inputHash).toMatch(/^[0-9a-f]{16}$/);
    expect(report.tools[0]?.definitionBytes).toBeGreaterThan(0);
  });
});
