import { describe, expect, it } from 'vitest';
import { createAllTools } from '../../../src/tools';
import { toStrictStandardSchema } from '../../../src/utils/validation';
import { testToolContext } from '../../tool-context';

// `.strict()` is shallow: a nested `z.object` keeps zod's default `strip` and drops a
// misspelled key without a word, which is #100 one level down. Checked on the JSON
// Schema the SDK advertises, so the guard reads what a client reads.

interface JsonSchemaNode {
  type?: string;
  additionalProperties?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
}

/** Paths of every object in the schema that accepts keys it does not declare. */
const openObjects = (node: JsonSchemaNode, path: string): string[] => [
  ...(node.type === 'object' && node.additionalProperties !== false ? [path || '(root)'] : []),
  ...Object.entries(node.properties ?? {}).flatMap(([key, child]) =>
    openObjects(child, path ? `${path}.${key}` : key),
  ),
  ...(node.items ? openObjects(node.items, `${path}[]`) : []),
  ...[...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])].flatMap((member) =>
    openObjects(member, path),
  ),
];

describe('tool input schemas reject unknown keys at every depth', () => {
  // brandIds 'all' adds the brand_id union to every brand-scoped Help Center tool.
  const tools = createAllTools(testToolContext({ brandIds: ['all'] }));

  it('every object, nested ones included, is advertised with additionalProperties: false', () => {
    const violations = tools.flatMap((tool) =>
      openObjects(
        toStrictStandardSchema(tool.inputSchema)['~standard'].jsonSchema.input({
          target: 'draft-2020-12',
        }) as JsonSchemaNode,
        '',
      ).map((path) => `${tool.name}: ${path}`),
    );

    expect(
      violations,
      'Add .strict() to these nested z.object schemas so a misspelled key fails loudly.',
    ).toEqual([]);
  });

  it('the walk reaches nested objects, array items and union members (guards the guard)', () => {
    const open = openObjects(
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          followers: { type: 'object' },
          list: { items: { type: 'object' } },
          either: { anyOf: [{ type: 'object' }] },
        },
      },
      '',
    );
    expect(open).toEqual(['followers', 'list[]', 'either']);
  });
});
