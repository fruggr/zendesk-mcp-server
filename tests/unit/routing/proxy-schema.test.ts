import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { Namespace } from '../../../src/config';
import {
  buildOperationFieldDescription,
  buildOperationList,
  buildProxyDescription,
  MAX_TOOL_DESCRIPTION_LENGTH,
  operationSignature,
  summarizeDescription,
  VERIFIED_SCHEMA_DESCRIPTION_LENGTH,
} from '../../../src/routing/proxy-schema';
import { filterTools, groupByNamespace, NAMESPACE_LABELS } from '../../../src/routing/registry';
import { createAllTools } from '../../../src/tools/index';

const byName = (a: string, b: string) => a.localeCompare(b);

const getThing = {
  name: 'get_thing',
  description: 'Retrieve a thing by ID. Lots more context that should be trimmed.',
  readOnly: true,
  inputSchema: z.object({
    thing_id: z.number().describe('Thing ID'),
    locale: z.string().optional().describe('Locale'),
  }),
};

const updateThing = {
  name: 'update_thing',
  description: 'Update a thing. Prefer update_thing_section for targeted edits.',
  readOnly: false,
  inputSchema: z.object({
    thing_id: z.number().describe('Thing ID'),
    format: z.enum(['html', 'markdown']).default('html').describe('Format'),
    label_names: z.array(z.string()).optional().describe('Labels'),
  }),
};

const listThings = {
  name: 'list_things',
  description: 'List things.',
  readOnly: true,
  inputSchema: z.object({}),
};

describe('summarizeDescription', () => {
  it('returns the first sentence when the description has multiple sentences', () => {
    expect(summarizeDescription('First. Second. Third.')).toBe('First.');
  });

  it('returns the whole string when there is no sentence delimiter', () => {
    expect(summarizeDescription('One sentence only')).toBe('One sentence only');
  });

  it('preserves the trailing period on the kept sentence', () => {
    expect(summarizeDescription('Do X. Then Y.')).toBe('Do X.');
  });

  it('handles an empty string', () => {
    expect(summarizeDescription('')).toBe('');
  });
});

describe('operationSignature', () => {
  it('lists every parameter in schema order, starring the required ones', () => {
    expect(operationSignature(getThing)).toBe('get_thing(thing_id*, locale)');
  });

  it('treats a defaulted parameter as optional, since the caller may omit it', () => {
    expect(operationSignature(updateThing)).toBe('update_thing(thing_id*, format, label_names)');
  });

  it('renders an operation without parameters with empty parentheses', () => {
    expect(operationSignature(listThings)).toBe('list_things()');
  });
});

describe('buildOperationList', () => {
  it('renders one line per operation: signature, first sentence, write marker', () => {
    expect(buildOperationList([getThing, updateThing, listThings])).toMatchInlineSnapshot(`
      "- get_thing(thing_id*, locale): Retrieve a thing by ID.
      - update_thing(thing_id*, format, label_names): Update a thing. (write)
      - list_things(): List things."
    `);
  });
});

describe('buildOperationFieldDescription', () => {
  it('explains the line format, then lists the operations', () => {
    expect(buildOperationFieldDescription([getThing, updateThing])).toMatchInlineSnapshot(`
      "One of the operations below. Each line reads name(parameters): summary, where the parameters are the exact names "params" accepts and * marks a required one; (write) marks an operation that changes data.
      - get_thing(thing_id*, locale): Retrieve a thing by ID.
      - update_thing(thing_id*, format, label_names): Update a thing. (write)"
    `);
  });
});

describe('buildProxyDescription', () => {
  it('points to the operation field and names every operation', () => {
    expect(
      buildProxyDescription({ title: 'Things', tools: [getThing, updateThing], readOnly: false }),
    ).toMatchInlineSnapshot(`
      "Things. Specify the operation and its parameters. The "operation" field lists every operation with a one-line summary and the parameter names "params" accepts (* = required); an unknown parameter is rejected with the list of valid ones.

      Operations: get_thing, update_thing"
    `);
  });

  it('starts with the [RO] marker in read-only mode, for clients that ignore annotations', () => {
    const description = buildProxyDescription({
      title: 'Things',
      tools: [getThing],
      readOnly: true,
    });
    expect(description.startsWith('[RO] Things. ')).toBe(true);
  });

  it('drops the name list rather than exceed the client description cap', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...listThings, name: `op_${i}_xxxxx` }));
    const description = buildProxyDescription({ title: 'Things', tools: many, readOnly: true });
    expect(description.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_LENGTH);
    expect(description).not.toContain('Operations:');
    expect(description).toContain('The "operation" field lists every operation');
  });

  it('keeps the name list when it fits exactly at the cap', () => {
    // With no tools the description already ends in an empty "Operations: ".
    const base = buildProxyDescription({ title: 'T', tools: [], readOnly: false });
    const name = 'x'.repeat(MAX_TOOL_DESCRIPTION_LENGTH - base.length);
    const exact = buildProxyDescription({
      title: 'T',
      tools: [{ ...listThings, name }],
      readOnly: false,
    });
    expect(exact).toHaveLength(MAX_TOOL_DESCRIPTION_LENGTH);
    expect(exact).toContain(name);

    const over = buildProxyDescription({
      title: 'T',
      tools: [{ ...listThings, name: `${name}x` }],
      readOnly: false,
    });
    expect(over).not.toContain('Operations:');
  });
});

// Guards against drift on the REAL surface: they iterate the live tool set and
// every namespace, so a new tool, parameter or namespace is covered with no
// edit here. Rationale and how to re-verify the limits:
// docs/decisions/proxy-schema-surface.md.
describe('proxy surface budgets (real tool set)', () => {
  const tools = createAllTools({ subdomain: 'testsubdomain', getToken: () => 'test-token' });
  const proxies = (readOnly: boolean) => {
    const filtered = filterTools(tools, { readOnly, namespaces: [...Namespace.options] });
    // Titles as `registerToolset` passes them: the title is part of the description.
    return [
      ...[...groupByNamespace(filtered)].map(([namespace, nsTools]) => ({
        name: namespace,
        title: NAMESPACE_LABELS[namespace].title,
        tools: nsTools,
      })),
      { name: 'single', title: 'Zendesk', tools: filtered },
    ].map((proxy) => ({ ...proxy, readOnly }));
  };
  const cases = [...proxies(false), ...proxies(true)];

  it('covers every namespace plus single mode, full and read-only', () => {
    expect(cases.map((c) => `${c.name}${c.readOnly ? ' (RO)' : ''}`).sort(byName)).toEqual(
      [...Namespace.options, 'single'].flatMap((n) => [n, `${n} (RO)`]).sort(byName),
    );
  });

  it.each(cases)(
    '$name (readOnly: $readOnly) keeps its description under the client cap, name list included',
    ({ title, tools: proxyTools, readOnly }) => {
      const description = buildProxyDescription({ title, tools: proxyTools, readOnly });
      expect(description.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_LENGTH);
      // The fallback that drops the list exists so the cap can never be crossed;
      // reaching it today means the surface outgrew the format, which deserves a
      // decision rather than a silent downgrade.
      expect(description, 'the operation name list no longer fits').toContain('Operations: ');
    },
  );

  it.each(cases)(
    '$name (readOnly: $readOnly) keeps its "operation" field within the client-verified length',
    ({ tools: proxyTools }) => {
      expect(
        buildOperationFieldDescription(proxyTools).length,
        're-run scripts/probe-mcp-description-cap.mjs before raising VERIFIED_SCHEMA_DESCRIPTION_LENGTH',
      ).toBeLessThanOrEqual(VERIFIED_SCHEMA_DESCRIPTION_LENGTH);
    },
  );

  describe.each(tools.map((tool) => ({ name: tool.name, tool })))('$name signature', ({ tool }) => {
    const signature = operationSignature(tool);
    const listed = signature
      .slice(signature.indexOf('(') + 1, -1)
      .split(', ')
      .filter(Boolean);
    const starred = listed.filter((p) => p.endsWith('*')).map((p) => p.slice(0, -1));

    it('lists exactly the parameters the strict parser accepts', () => {
      expect(listed.map((p) => p.replace(/\*$/, '')).sort(byName)).toEqual(
        Object.keys(tool.inputSchema.shape).sort(byName),
      );
    });

    // Independent oracle: the JSON Schema `required` a flat-mode client receives.
    it('stars exactly the parameters the JSON Schema marks required', () => {
      const json = z.toJSONSchema(tool.inputSchema, { io: 'input' }) as { required?: string[] };
      expect(starred.sort(byName)).toEqual([...(json.required ?? [])].sort(byName));
    });
  });
});
