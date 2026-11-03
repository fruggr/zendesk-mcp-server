import { describe, expect, it } from 'vitest';
import {
  type CustomizationEdit,
  type Customizations,
  EMPTY_CUSTOMIZATIONS,
  INSTRUCTION_MAX_CHARS,
  INSTRUCTIONS_TOTAL_MAX_CHARS,
  isCustomizationError,
  PROMPT_MAX_CHARS,
  parseCustomizations,
  parseFrontmatter,
  planEdit,
  SKILL_MAX_FILES,
} from '../../../src/customization/model';
import { compareCodeUnits } from '../../../src/utils/compare';

const tree = (
  files: Record<string, string>,
  authors: Record<string, { name: string; at: string }> = {},
) => ({
  files: new Map(Object.entries(files)),
  authors: new Map(Object.entries(authors)),
});

const SKILL = '---\nname: lexicon\ndescription: "Our words: use them."\n---\n\nSay workspace.\n';

const refusal = (current: Customizations, edit: CustomizationEdit): string => {
  try {
    planEdit(current, edit);
  } catch (err) {
    if (isCustomizationError(err)) return err.message;
    throw err;
  }
  throw new Error('the edit was accepted');
};

describe('parseFrontmatter', () => {
  it('reads single-line fields, quoted or not, and the body after the block', () => {
    const { fields, body } = parseFrontmatter(
      `---\nname: x\ndescription: "a: \\"b\\""\ntitle: 'it''s'\n  nested: no\n---\nBody`,
    );
    expect(Object.fromEntries(fields)).toEqual({ name: 'x', description: 'a: "b"', title: "it's" });
    expect(body).toBe('Body');
  });

  it('treats text without a leading block as all body', () => {
    expect(parseFrontmatter('Just text')).toEqual({ fields: new Map(), body: 'Just text' });
  });

  it('keeps a malformed double-quoted value as written', () => {
    expect(parseFrontmatter('---\nd: "open\n---\n').fields.get('d')).toBe('"open');
  });
});

describe('parseCustomizations', () => {
  it('sorts the files into instructions, prompts and skills, with their authors', () => {
    const author = { name: 'Ada (Zendesk user 1)', at: '2026-11-01T10:00:00.000Z' };
    const state = parseCustomizations(
      tree(
        {
          'instructions/global.md': '  Be brief.\n',
          'instructions/help_center.md': 'Cite the article.',
          'prompts/draft-reply.md':
            '---\ntitle: "Draft"\ndescription: "Draft a reply."\n---\n\nDraft it.\n',
          'skills/lexicon/SKILL.md': SKILL,
          'skills/lexicon/references/words.md': 'workspace',
        },
        { 'instructions/global.md': author, 'skills/lexicon/SKILL.md': author },
      ),
    );
    expect(state.instructions.get('global')).toEqual({
      scope: 'global',
      text: 'Be brief.',
      author,
    });
    expect(state.instructions.get('help_center')?.author).toBeUndefined();
    expect(state.prompts.get('draft-reply')).toEqual({
      name: 'draft-reply',
      title: 'Draft',
      description: 'Draft a reply.',
      text: 'Draft it.',
      author: undefined,
    });
    expect(state.skills.get('lexicon')).toEqual({
      name: 'lexicon',
      description: 'Our words: use them.',
      files: new Map([
        ['SKILL.md', SKILL],
        ['references/words.md', 'workspace'],
      ]),
      author,
    });
    expect(state.ignored).toEqual([]);
  });

  it('lists, and serves nothing for, what no entry explains', () => {
    const state = parseCustomizations(
      tree({
        'instructions/unknown.md': 'x',
        'instructions/global.md': '   ',
        'instructions/nested/global.md': 'x',
        'instructions/global.txt': 'x',
        'prompts/no-description.md': 'Body only',
        'prompts/Bad_Name.md': '---\ndescription: d\n---\nx',
        'prompts/sub/x.md': '---\ndescription: d\n---\nx',
        'skills/no-entry/notes.md': 'x',
        'skills/Bad_Name/SKILL.md': SKILL,
        'skills/bare': 'x',
        'notes.md': 'x',
        'toString/x.md': 'x',
      }),
    );
    expect(state.instructions.size + state.prompts.size + state.skills.size).toBe(0);
    expect([...state.ignored].sort(compareCodeUnits)).toMatchInlineSnapshot(`
      [
        "instructions/global.md",
        "instructions/global.txt",
        "instructions/nested/global.md",
        "instructions/unknown.md",
        "notes.md",
        "prompts/Bad_Name.md",
        "prompts/no-description.md",
        "prompts/sub/x.md",
        "skills/Bad_Name/SKILL.md",
        "skills/bare",
        "skills/no-entry/notes.md",
        "toString/x.md",
      ]
    `);
  });

  it('serves the prompt, not the skill, when a name is taken by both', () => {
    const state = parseCustomizations(
      tree({
        'prompts/lexicon.md': '---\ndescription: d\n---\nx',
        'skills/lexicon/SKILL.md': SKILL,
      }),
    );
    expect([...state.prompts.keys()]).toEqual(['lexicon']);
    expect(state.skills.size).toBe(0);
    expect(state.ignored).toEqual(['skills/lexicon/SKILL.md']);
  });
});

describe('planEdit', () => {
  const current = parseCustomizations(
    tree({
      'instructions/global.md': 'Be brief.',
      'prompts/draft-reply.md': '---\ndescription: d\n---\nx',
      'skills/lexicon/SKILL.md': SKILL,
      'skills/lexicon/references/words.md': 'workspace',
    }),
  );

  describe('instructions', () => {
    it('writes trimmed text, and removes it', () => {
      expect(
        planEdit(current, { kind: 'instructions', scope: 'tickets', text: ' Tag it. ' }),
      ).toEqual([{ path: 'instructions/tickets.md', content: 'Tag it.\n' }]);
      expect(planEdit(current, { kind: 'instructions', scope: 'global', text: null })).toEqual([
        { path: 'instructions/global.md', content: null },
      ]);
    });

    it('refuses empty text, a missing entry to delete, and text over the limits', () => {
      expect(refusal(current, { kind: 'instructions', scope: 'users', text: '  ' })).toBe(
        'The instructions are empty; delete them instead.',
      );
      expect(refusal(current, { kind: 'instructions', scope: 'users', text: null })).toBe(
        'No instructions are set for "users".',
      );
      expect(
        refusal(current, {
          kind: 'instructions',
          scope: 'users',
          text: 'x'.repeat(INSTRUCTION_MAX_CHARS + 1),
        }),
      ).toBe(
        `The "users" instructions is ${INSTRUCTION_MAX_CHARS + 1} characters long; the limit is ${INSTRUCTION_MAX_CHARS}.`,
      );
      expect(
        planEdit(current, {
          kind: 'instructions',
          scope: 'users',
          text: 'x'.repeat(INSTRUCTION_MAX_CHARS),
        }),
      ).toHaveLength(1);
    });

    it('counts every scope but the one replaced against the total', () => {
      const full = parseCustomizations(
        tree({
          'instructions/global.md': 'x'.repeat(INSTRUCTION_MAX_CHARS),
          'instructions/tickets.md': 'x'.repeat(INSTRUCTION_MAX_CHARS),
          'instructions/users.md': 'x'.repeat(INSTRUCTION_MAX_CHARS - 1),
        }),
      );
      expect(
        planEdit(full, {
          kind: 'instructions',
          scope: 'users',
          text: 'x'.repeat(INSTRUCTION_MAX_CHARS),
        }),
      ).toHaveLength(1);
      expect(refusal(full, { kind: 'instructions', scope: 'requests', text: 'xy' })).toBe(
        `All instructions together would be ${INSTRUCTIONS_TOTAL_MAX_CHARS + 1} characters long; the limit is ${INSTRUCTIONS_TOTAL_MAX_CHARS}, since every session receives them. Shorten them, or move reference material into a skill.`,
      );
    });
  });

  describe('prompts', () => {
    it('writes the frontmatter it reads back, and removes a prompt', () => {
      const [change] = planEdit(current, {
        kind: 'prompt',
        name: 'triage',
        prompt: { title: ' Triage ', description: ' Triage: "fast". ', text: ' Do it. ' },
      });
      expect(change).toEqual({
        path: 'prompts/triage.md',
        content: '---\ntitle: "Triage"\ndescription: "Triage: \\"fast\\"."\n---\n\nDo it.\n',
      });
      const back = parseCustomizations(tree({ [change?.path ?? '']: change?.content ?? '' }));
      expect(back.prompts.get('triage')).toMatchObject({
        title: 'Triage',
        description: 'Triage: "fast".',
        text: 'Do it.',
      });
      expect(
        planEdit(current, {
          kind: 'prompt',
          name: 'triage',
          prompt: { description: 'd', text: 'x' },
        })[0]?.content,
      ).toBe('---\ndescription: "d"\n---\n\nx\n');
      expect(planEdit(current, { kind: 'prompt', name: 'draft-reply', prompt: null })).toEqual([
        { path: 'prompts/draft-reply.md', content: null },
      ]);
    });

    it('refuses what a client could not list or a model could not use', () => {
      const prompt = { description: 'd', text: 'x' };
      expect(refusal(current, { kind: 'prompt', name: 'Draft_Reply', prompt })).toBe(
        'Invalid prompt name "Draft_Reply": use lowercase letters, digits and single hyphens (e.g. draft-reply), at most 64 characters.',
      );
      expect(refusal(current, { kind: 'prompt', name: 'a'.repeat(65), prompt })).toContain(
        'Invalid prompt name',
      );
      expect(planEdit(current, { kind: 'prompt', name: 'a'.repeat(64), prompt })).toHaveLength(1);
      expect(refusal(current, { kind: 'prompt', name: 'lexicon', prompt })).toBe(
        'A skill is already named "lexicon", and every skill is served as a prompt of its name.',
      );
      expect(
        refusal(current, { kind: 'prompt', name: 'x', prompt: { description: ' ', text: 'x' } }),
      ).toBe(
        'A prompt needs a one-line description: it is what clients show in their prompt menu.',
      );
      expect(
        refusal(current, { kind: 'prompt', name: 'x', prompt: { description: 'a\nb', text: 'x' } }),
      ).toContain('one-line description');
      expect(
        refusal(current, { kind: 'prompt', name: 'x', prompt: { description: 'd', text: ' ' } }),
      ).toBe('The prompt text is empty.');
      expect(
        refusal(current, {
          kind: 'prompt',
          name: 'x',
          prompt: { description: 'd', text: 'x'.repeat(PROMPT_MAX_CHARS + 1) },
        }),
      ).toBe(
        `The prompt text is ${PROMPT_MAX_CHARS + 1} characters long; the limit is ${PROMPT_MAX_CHARS}.`,
      );
      expect(refusal(current, { kind: 'prompt', name: 'nope', prompt: null })).toBe(
        'No prompt is named "nope".',
      );
    });
  });

  describe('skills', () => {
    it('writes SKILL.md by default, then other files, and deletes one file or the whole skill', () => {
      const created = '---\nname: style\ndescription: Style.\n---\nWrite well.';
      expect(planEdit(current, { kind: 'skill', name: 'style', text: created })).toEqual([
        { path: 'skills/style/SKILL.md', content: created },
      ]);
      expect(
        planEdit(current, {
          kind: 'skill',
          name: 'lexicon',
          path: 'references/more.md',
          text: 'x',
        }),
      ).toEqual([{ path: 'skills/lexicon/references/more.md', content: 'x' }]);
      expect(
        planEdit(current, {
          kind: 'skill',
          name: 'lexicon',
          path: 'references/words.md',
          text: null,
        }),
      ).toEqual([{ path: 'skills/lexicon/references/words.md', content: null }]);
      expect(planEdit(current, { kind: 'skill', name: 'lexicon', text: null })).toEqual([
        { path: 'skills/lexicon/SKILL.md', content: null },
        { path: 'skills/lexicon/references/words.md', content: null },
      ]);
    });

    it('refuses a SKILL.md a client could not load', () => {
      expect(
        refusal(current, {
          kind: 'skill',
          name: 'style',
          text: '---\nname: other\ndescription: d\n---\nx',
        }),
      ).toBe(
        'SKILL.md must start with a frontmatter block whose name is "style" (---, name: style, description: ..., ---).',
      );
      for (const description of ['', '>', '|', '>-', '|-']) {
        expect(
          refusal(current, {
            kind: 'skill',
            name: 'style',
            text: `---\nname: style\ndescription: ${description}\n---\nx`,
          }),
        ).toBe(
          'SKILL.md needs a one-line description in its frontmatter: it decides when a client loads the skill.',
        );
      }
      expect(
        refusal(current, {
          kind: 'skill',
          name: 'style',
          text: '---\nname: style\ndescription: d\n---\n  ',
        }),
      ).toBe('SKILL.md has no instructions after its frontmatter.');
    });

    it('refuses a file outside the rules, or before the skill exists', () => {
      for (const path of ['../x.md', 'a//b.md', '.hidden', 'a/b/c/d/e.md', 'sp ace.md']) {
        expect(refusal(current, { kind: 'skill', name: 'lexicon', path, text: 'x' })).toContain(
          `Invalid skill file path "${path}"`,
        );
      }
      expect(
        planEdit(current, { kind: 'skill', name: 'lexicon', path: 'a/b/c/d.md', text: 'x' }),
      ).toHaveLength(1);
      expect(refusal(current, { kind: 'skill', name: 'style', path: 'notes.md', text: 'x' })).toBe(
        'Create the skill\'s SKILL.md first, then add "notes.md".',
      );
      expect(refusal(current, { kind: 'skill', name: 'draft-reply', text: SKILL })).toBe(
        'A prompt is already named "draft-reply", and every skill is also served as a prompt of its name.',
      );
      expect(refusal(current, { kind: 'skill', name: 'nope', text: null })).toBe(
        'No skill is named "nope".',
      );
      expect(
        refusal(current, { kind: 'skill', name: 'lexicon', path: 'none.md', text: null }),
      ).toBe('The skill "lexicon" has no file "none.md".');
    });

    it('caps a file, the file count and the whole skill', () => {
      expect(
        refusal(current, {
          kind: 'skill',
          name: 'lexicon',
          path: 'big.md',
          text: 'x'.repeat(64_001),
        }),
      ).toBe('The file "big.md" is 64001 characters long; the limit is 64000.');
      const crowded = parseCustomizations(
        tree({
          'skills/lexicon/SKILL.md': SKILL,
          ...Object.fromEntries(
            Array.from({ length: SKILL_MAX_FILES - 1 }, (_, i) => [
              `skills/lexicon/f${i}.md`,
              'x'.repeat(8000),
            ]),
          ),
        }),
      );
      expect(
        planEdit(crowded, { kind: 'skill', name: 'lexicon', path: 'f0.md', text: 'y' }),
      ).toHaveLength(1);
      expect(
        refusal(crowded, { kind: 'skill', name: 'lexicon', path: 'extra.md', text: 'y' }),
      ).toBe(`A skill holds at most ${SKILL_MAX_FILES} files.`);
      expect(
        refusal(crowded, {
          kind: 'skill',
          name: 'lexicon',
          path: 'f0.md',
          text: 'x'.repeat(16_000),
        }),
      ).toMatch(/^The skill would hold \d+ characters; the limit is 256000\.$/);
    });
  });

  it('starts from an empty state', () => {
    expect(
      planEdit(EMPTY_CUSTOMIZATIONS, { kind: 'instructions', scope: 'global', text: 'x' }),
    ).toHaveLength(1);
  });
});
