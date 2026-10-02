import { describe, expect, it } from 'vitest';
import { createAllTools, type ToolContext } from '../../../src/tools';
import {
  formatArticleSummary,
  formatAudit,
  formatRequest,
  formatTicket,
  INPUT_NAME_OF,
} from '../../../src/utils/formatting';
import { MOCK_ARTICLE, MOCK_REQUEST, MOCK_TICKET } from '../../msw-handlers';

// An agent writes back what it just read (#339): every field a write tool sets
// must reach it under that input's name — shown as-is, or annotated
// `**Label** (input_name)` when the display label differs.

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'test-token' };
const tools = createAllTools(ctx);

const inputsOf = (name: string): string[] => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return Object.keys(tool.inputSchema.shape);
};

const normalise = (label: string) => label.toLowerCase().replaceAll(' ', '_');

// `**Label**:` or `**Label** (input_name):`
const shownFields = (text: string) =>
  [...text.matchAll(/\*\*([^*]+)\*\*(?: \(([a-z_]+)\))?:/g)].map(([, label, input]) => ({
    label,
    input,
  }));

const CASES = [
  {
    formatter: 'formatArticleSummary',
    text: formatArticleSummary({ ...MOCK_ARTICLE, promoted: true }),
    writeTools: ['create_article', 'update_article'],
    // Set by the write tool but not part of this read: the id selects the
    // record, title/body live on the translation, and the rest are not shown.
    notShown: ['article_id', 'title', 'body', 'author_id', 'content_tag_ids'],
  },
  {
    formatter: 'formatTicket',
    text: formatTicket(MOCK_TICKET),
    writeTools: ['create_ticket', 'update_ticket'],
    notShown: [
      'ticket_id',
      'subject',
      'description',
      'group_id',
      'custom_fields',
      'followers',
      'email_ccs',
    ],
  },
  {
    formatter: 'formatRequest',
    text: formatRequest(MOCK_REQUEST),
    writeTools: ['create_request'],
    notShown: ['subject', 'body', 'custom_fields', 'attachments'],
  },
  {
    // The history an agent reads before undoing a change: one Change event per
    // field update_ticket can set.
    formatter: 'formatAudit',
    text:
      formatAudit(
        {
          id: 1,
          ticket_id: 1,
          created_at: '2026-01-01T00:00:00Z',
          author_id: 100,
          events: [
            ['status', 'open', 'new'],
            ['priority', 'high', 'normal'],
            ['type', 'problem', 'incident'],
            ['assignee_id', 101, 100],
            ['group_id', 301, 300],
            ['subject', 'New', 'Old'],
            ['tags', ['b'], ['a']],
          ].map(([field_name, value, previous_value], id) => ({
            id,
            type: 'Change',
            field_name: field_name as string,
            value,
            previous_value,
          })),
        },
        { users: new Map(), groups: new Map() },
      ) ?? '',
    writeTools: ['update_ticket'],
    notShown: ['ticket_id', 'custom_fields', 'followers', 'email_ccs'],
  },
] as const;

describe.each(CASES)('$formatter output names', ({ text, writeTools, notShown }) => {
  const fields = shownFields(text);
  const inputs = new Set(writeTools.flatMap(inputsOf));

  it('annotates only with an input the write tools really take', () => {
    for (const { label, input } of fields.filter((f) => f.input)) {
      for (const tool of writeTools) {
        expect(inputsOf(tool), `${label} → ${input} on ${tool}`).toContain(input);
      }
    }
  });

  it('reaches every write input under its own name, or lists it as not shown', () => {
    const reachable = new Set([
      ...fields.map((f) => f.input ?? normalise(f.label)),
      ...(notShown as readonly string[]),
    ]);
    const unreachable = [...inputs].filter((i) => !reachable.has(i));
    expect(
      unreachable,
      'a write input the agent cannot map back from this output: annotate its label via INPUT_NAME_OF, or add it to notShown',
    ).toEqual([]);
  });

  it('keeps notShown honest: no entry that is no longer a write input', () => {
    expect((notShown as readonly string[]).filter((i) => !inputs.has(i))).toEqual([]);
  });
});

describe('INPUT_NAME_OF', () => {
  it('pairs each display label with the input that sets it', () => {
    expect(INPUT_NAME_OF).toMatchInlineSnapshot(`
      {
        "Assignee": "assignee_id",
        "Form": "form_id",
        "Labels": "label_names",
        "Permission group": "permission_group_id",
        "Section": "section_id",
        "User segment": "user_segment_id",
        "assignee": "assignee_id",
        "group": "group_id",
      }
    `);
  });
});
