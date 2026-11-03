import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryBackend } from '../../../src/customization/backend';
import { parseCustomizations } from '../../../src/customization/model';
import {
  buildCustomInstructions,
  DERIVED_PROMPT_MAX_CHARS,
  derivedPromptText,
  serveCustomizations,
} from '../../../src/customization/serve';
import { createCustomizationService } from '../../../src/customization/service';

const ADA = { name: 'Ada', at: '2026-11-01T10:00:00.000Z' };
const SKILL = '---\nname: lexicon\ndescription: "Our words: use them."\n---\n\nSay workspace.\n';

const state = (files: Record<string, string>) =>
  parseCustomizations({ files: new Map(Object.entries(files)), authors: new Map() });

const skillOf = (files: Record<string, string>) => {
  const skill = state(
    Object.fromEntries(
      Object.entries(files).map(([path, text]) => [`skills/lexicon/${path}`, text]),
    ),
  ).skills.get('lexicon');
  if (!skill) throw new Error('no skill');
  return skill;
};

describe('buildCustomInstructions', () => {
  const all = state({
    'instructions/global.md': 'Be brief.',
    'instructions/tickets.md': 'Tag every ticket.',
    'instructions/help_center.md': 'Cite the article.',
    'instructions/requests.md': 'Never promise a date.',
  });

  it('gives the global instructions, then those of each namespace the session exposes', () => {
    expect(
      buildCustomInstructions(all, { namespaces: ['help_center', 'tickets'] }),
    ).toMatchInlineSnapshot(`
        "Your team's own instructions, set by its Zendesk admins:

        Be brief.

        For the Help Center:
        Cite the article.

        For tickets:
        Tag every ticket."
      `);
    expect(
      buildCustomInstructions(all, { namespaces: ['requests', 'users', 'preferences'] }),
    ).toMatchInlineSnapshot(`
        "Your team's own instructions, set by its Zendesk admins:

        Be brief.

        For customers' requests:
        Never promise a date."
      `);
  });

  it('labels every namespace', () => {
    const each = state({
      'instructions/users.md': 'u',
      'instructions/preferences.md': 'p',
    });
    expect(buildCustomInstructions(each, { namespaces: ['users', 'preferences'] })).toBe(
      "Your team's own instructions, set by its Zendesk admins:\n\nFor users and organizations:\nu\n\nFor connector preferences:\np",
    );
  });

  it('gives nothing when no instructions apply', () => {
    expect(buildCustomInstructions(state({}), { namespaces: ['tickets'] })).toBeUndefined();
    expect(buildCustomInstructions(all, { namespaces: ['users'] })).toContain('Be brief.');
    expect(
      buildCustomInstructions(state({ 'instructions/tickets.md': 't' }), { namespaces: ['users'] }),
    ).toBeUndefined();
  });
});

describe('derivedPromptText', () => {
  it('sends a client with the skill back to it, and lists what the conversion dropped', () => {
    expect(
      derivedPromptText(
        skillOf({ 'SKILL.md': SKILL, 'scripts/check.py': 'print()', 'references/words.md': 'w' }),
      ),
    ).toMatchInlineSnapshot(`
      "[Note from the MCP server] This prompt is the skill "lexicon" (skill://lexicon/SKILL.md) converted for clients that do not support MCP skills.
      If "lexicon" is among the skills available to you, stop reading this prompt: load that skill and follow it instead.
      Otherwise follow the instructions below, knowing the conversion is lossy: the skill's other files are not included and its scripts cannot run here. If something below does not work as it says, that is a limit of this conversion, not a mistake on your side.

      ---

      Say workspace.

      ---

      Files of this skill not included here (MCP resources, if your client can read them):
      - skill://lexicon/references/words.md
      - skill://lexicon/scripts/check.py"
    `);
  });

  it('ends with the body when the skill has no other file', () => {
    expect(derivedPromptText(skillOf({ 'SKILL.md': SKILL }))).toMatch(/---\n\nSay workspace\.$/);
  });

  it('truncates a long body and says where the full text is', () => {
    const body = 'x'.repeat(DERIVED_PROMPT_MAX_CHARS + 1);
    const text = derivedPromptText(skillOf({ 'SKILL.md': `${SKILL}${body}` }));
    expect(text).toContain(
      '\n\n[Truncated by the MCP server: the full text is skill://lexicon/SKILL.md.]',
    );
    expect(text).not.toContain('x'.repeat(DERIVED_PROMPT_MAX_CHARS));
    const exact = derivedPromptText(
      skillOf({
        'SKILL.md': `---\nname: lexicon\ndescription: d\n---\n${'y'.repeat(DERIVED_PROMPT_MAX_CHARS)}`,
      }),
    );
    expect(exact).not.toContain('Truncated');
  });
});

describe('serveCustomizations', () => {
  const open: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const item of open.splice(0)) await item.close();
  });

  const connect = async (
    service: Awaited<ReturnType<typeof createCustomizationService>>,
    live: boolean,
  ) => {
    const server = new McpServer({ name: 't', version: '0' });
    serveCustomizations(server, service, { live });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientTransport);
    open.push(client, server);
    return { server, client };
  };

  it('serves the prompts and one prompt per skill, and the skills only when there is one', async () => {
    const empty = await createCustomizationService(createMemoryBackend());
    const bare = await connect(empty, false);
    expect((await bare.client.listPrompts()).prompts).toEqual([]);
    expect(bare.client.getServerCapabilities()?.resources).toBeUndefined();

    const service = await createCustomizationService(
      createMemoryBackend({
        'prompts/draft-reply.md':
          '---\ntitle: "Draft"\ndescription: "Draft a reply."\n---\nDraft it.',
        'prompts/plain.md': '---\ndescription: "Plain."\n---\nGo.',
        'skills/lexicon/SKILL.md': SKILL,
      }),
    );
    const { client } = await connect(service, false);
    expect((await client.listPrompts()).prompts).toEqual([
      { name: 'draft-reply', title: 'Draft', description: 'Draft a reply.' },
      { name: 'plain', description: 'Plain.' },
      {
        name: 'lexicon',
        description:
          'Our words: use them. (The skill "lexicon" as a prompt: use the skill itself when your client supports MCP skills.)',
      },
    ]);
    expect(await client.getPrompt({ name: 'draft-reply' })).toEqual({
      messages: [{ role: 'user', content: { type: 'text', text: 'Draft it.' } }],
    });
    const derived = await client.getPrompt({ name: 'lexicon' });
    expect(derived.messages[0]?.content).toHaveProperty(
      'text',
      expect.stringContaining('stop reading this prompt'),
    );
    expect(client.getServerCapabilities()?.resources).toBeDefined();
  });

  it('swaps the prompts of a live session after an edit, and notifies it', async () => {
    const service = await createCustomizationService(createMemoryBackend());
    const { client } = await connect(service, true);
    const changed = vi.fn();
    client.setNotificationHandler('notifications/prompts/list_changed', changed);
    await service.edit(
      { kind: 'prompt', name: 'triage', prompt: { description: 'Triage.', text: 'Do it.' } },
      ADA,
    );
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(['triage']);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  });

  it('leaves a per-request server alone after an edit, and stops listening once a live one closes', async () => {
    const service = await createCustomizationService(createMemoryBackend());
    const listeners = vi.spyOn(service, 'onChange');
    const once = await connect(service, false);
    expect(listeners).not.toHaveBeenCalled();
    const live = await connect(service, true);
    const unsubscribe = listeners.mock.results[0]?.value as () => boolean;
    await live.client.close();
    await live.server.close();
    expect(unsubscribe()).toBe(false);
    await service.edit(
      { kind: 'prompt', name: 'triage', prompt: { description: 'Triage.', text: 'Do it.' } },
      ADA,
    );
    expect((await once.client.listPrompts()).prompts).toEqual([]);
  });
});
