import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAdminServer,
  createAdminTools,
  effectiveInstructions,
  loadSetupSkill,
} from '../../../src/customization/admin';
import { createMemoryBackend } from '../../../src/customization/backend';
import {
  type CustomizationService,
  createCustomizationService,
} from '../../../src/customization/service';
import { SETUP_BODY } from '../../../src/customization/setup';
import { createRequestStateCodec } from '../../../src/utils/request-state';
import { makeConfig } from '../../integration/harness';
import { MOCK_USER } from '../../msw-handlers';
import { mswServer } from '../../setup';

const ME = 'https://testsubdomain.zendesk.com/api/v2/users/me';
const SKILL = '---\nname: lexicon\ndescription: "Our words: use them."\n---\n\nSay workspace.\n';
const config = makeConfig({ namespaces: ['tickets', 'help_center'] });
const caller = { getToken: () => 'zd-token' };

let service: CustomizationService;
let tool: ReturnType<typeof createAdminTools>[number];

const call = async (params: Record<string, unknown>) => {
  const result = await tool.handler(params, caller);
  return (result.content[0] as { text: string }).text;
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-01T10:00:00Z') });
  service = await createCustomizationService(createMemoryBackend());
  [tool] = createAdminTools({ config, service }) as [typeof tool];
});
afterEach(() => vi.useRealTimers());

describe('manage_customizations', () => {
  it('is the one back-office tool, writing nothing to Zendesk', () => {
    expect(createAdminTools({ config, service }).map((t) => t.name)).toEqual([
      'manage_customizations',
    ]);
    expect(tool.readOnly).toBe(false);
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('refuses a caller whose Zendesk role is not admin, before anything else', async () => {
    mswServer.use(http.get(ME, () => HttpResponse.json({ user: { ...MOCK_USER, role: 'agent' } })));
    await expect(
      call({ action: 'set', kind: 'instructions', name: 'global', content: 'x' }),
    ).rejects.toThrow(
      'This back-office is reserved for Zendesk administrators: your Zendesk role is not admin.',
    );
    expect(service.current().instructions.size).toBe(0);
  });

  it('lists the built-in context, then what is configured, with who changed it', async () => {
    expect(await call({ action: 'list' })).toMatchInlineSnapshot(`
      "## Built in (read only, sent by the server on its own)
      - instructions: what every session already receives. Read it with action "get", kind "built_in", name "instructions".
      - topology: the Help Center structure (locales, categories and sections with ids, segments, permission groups, the caller's role), served to every session as a resource. Read it with kind "built_in", name "topology".

      ## Instructions
      (none)

      ## Prompts
      (none)

      ## Skills
      (none)

      Limits: 4000 characters per instructions scope and 12000 for all of them; 32000 per prompt; a skill's derived prompt carries the first 16000 characters of its SKILL.md."
    `);
    await call({ action: 'set', kind: 'instructions', name: 'global', content: 'Be brief.' });
    await call({
      action: 'set',
      kind: 'prompt',
      name: 'draft-reply',
      description: 'Draft a reply.',
      content: 'Draft.',
    });
    await call({ action: 'set', kind: 'skill', name: 'lexicon', content: SKILL });
    await call({ action: 'set', kind: 'skill', name: 'lexicon', path: 'b.md', content: 'b' });
    await call({ action: 'set', kind: 'skill', name: 'lexicon', path: 'a.md', content: 'a' });
    const listed = await call({ action: 'list' });
    expect(
      listed.slice(listed.indexOf('## Instructions'), listed.indexOf('\n\nLimits')),
    ).toMatchInlineSnapshot(`
      "## Instructions
      - global: 9 characters, last changed by Test User (Zendesk user 9999) on 2026-11-01

      ## Prompts
      - draft-reply: Draft a reply., last changed by Test User (Zendesk user 9999) on 2026-11-01

      ## Skills
      - lexicon: Our words: use them. (files: SKILL.md, a.md, b.md), last changed by Test User (Zendesk user 9999) on 2026-11-01"
    `);
  });

  it('names a nameless admin by their id', async () => {
    mswServer.use(http.get(ME, () => HttpResponse.json({ user: { id: 7, role: 'admin' } })));
    await call({ action: 'set', kind: 'instructions', name: 'global', content: 'x' });
    expect(service.current().instructions.get('global')?.author).toEqual({
      name: 'user 7 (Zendesk user 7)',
      at: '2026-11-01T10:00:00.000Z',
    });
  });

  describe('get', () => {
    it('reads the built-in instructions and the Help Center topology', async () => {
      expect(await call({ action: 'get', kind: 'built_in', name: 'instructions' })).toContain(
        'This MCP server is connected to the Zendesk Help Center of "testsubdomain".',
      );
      expect(await call({ action: 'get', kind: 'built_in', name: 'topology' })).toContain(
        'Locales',
      );
      await expect(call({ action: 'get', kind: 'built_in', name: 'sla' })).rejects.toThrow(
        'Unknown built-in "sla": use instructions or topology. Nothing was changed.',
      );
    });

    it('says when the server sends no built-in instructions', async () => {
      const [bare] = createAdminTools({
        config: makeConfig({ namespaces: ['users'] }),
        service,
      }) as [typeof tool];
      const result = await bare.handler(
        { action: 'get', kind: 'built_in', name: 'instructions' },
        caller,
      );
      expect(result.content).toEqual([{ type: 'text', text: '(none)' }]);
    });

    it('reads each kind of entry, or says it does not exist', async () => {
      await call({ action: 'set', kind: 'instructions', name: 'tickets', content: 'Tag it.' });
      await call({
        action: 'set',
        kind: 'prompt',
        name: 'draft-reply',
        title: 'Draft',
        description: 'Draft a reply.',
        content: 'Draft.',
      });
      await call({
        action: 'set',
        kind: 'prompt',
        name: 'plain',
        description: 'Plain.',
        content: 'Go.',
      });
      await call({ action: 'set', kind: 'skill', name: 'lexicon', content: SKILL });
      expect(await call({ action: 'get', kind: 'instructions', name: 'tickets' })).toBe('Tag it.');
      expect(await call({ action: 'get', kind: 'instructions', name: 'users' })).toBe(
        'No instructions are set for "users".',
      );
      expect(await call({ action: 'get', kind: 'prompt', name: 'draft-reply' })).toBe(
        'Title: Draft\nDescription: Draft a reply.\n\nDraft.',
      );
      expect(await call({ action: 'get', kind: 'prompt', name: 'plain' })).toBe(
        'Description: Plain.\n\nGo.',
      );
      expect(await call({ action: 'get', kind: 'prompt', name: 'nope' })).toBe(
        'No prompt is named "nope".',
      );
      expect(await call({ action: 'get', kind: 'skill', name: 'lexicon' })).toBe(
        `Files: SKILL.md\nURI: skill://lexicon/SKILL.md\n\n${SKILL}`,
      );
      expect(await call({ action: 'get', kind: 'skill', name: 'lexicon', path: 'x.md' })).toBe(
        'The skill "lexicon" has no file "x.md".',
      );
      expect(await call({ action: 'get', kind: 'skill', name: 'nope' })).toBe(
        'No skill is named "nope".',
      );
    });

    it('names what is missing from the call', async () => {
      await expect(call({ action: 'get', name: 'global' })).rejects.toThrow(
        'kind is required here. Nothing was changed.',
      );
      await expect(call({ action: 'get', kind: 'prompt' })).rejects.toThrow(
        'name is required here.',
      );
      await expect(
        call({ action: 'get', kind: 'instructions', name: 'everything' }),
      ).rejects.toThrow(
        'Unknown instructions scope "everything": use one of global, tickets, help_center, users, requests, preferences.',
      );
    });
  });

  describe('set and delete', () => {
    it('shows an admin everything a new session receives after setting instructions', async () => {
      const text = await call({
        action: 'set',
        kind: 'instructions',
        name: 'global',
        content: 'Be brief.',
      });
      expect(text).toBe(
        `Saved instructions "global". A new session on /mcp now receives these instructions (the built-in part first); check them for repetitions and contradictions:\n\n${effectiveInstructions(config, service.current())}`,
      );
      expect(effectiveInstructions(config, service.current())).toMatch(
        /^This MCP server is connected to[\s\S]*\n\nYour team's own instructions, set by its Zendesk admins:\n\nBe brief\.$/,
      );
      expect(await call({ action: 'delete', kind: 'instructions', name: 'global' })).toMatch(
        /^Deleted instructions "global"\./,
      );
      expect(effectiveInstructions(makeConfig({ namespaces: ['users'] }), service.current())).toBe(
        '(none)',
      );
    });

    it('confirms a prompt and a skill with how clients get them', async () => {
      expect(
        await call({
          action: 'set',
          kind: 'prompt',
          name: 'draft-reply',
          description: 'd',
          content: 'x',
        }),
      ).toBe(
        'Saved prompt "draft-reply". It appears in the prompt menu of clients that refresh their prompt list.',
      );
      expect(await call({ action: 'set', kind: 'skill', name: 'lexicon', content: SKILL })).toBe(
        'Saved skill "lexicon". Clients supporting MCP skills get it as skill://lexicon/SKILL.md; the others get the prompt "lexicon", carrying SKILL.md only.',
      );
      expect(
        await call({ action: 'set', kind: 'skill', name: 'lexicon', path: 'a.md', content: 'a' }),
      ).toMatch(/^Saved skill "lexicon" \(a\.md\)\./);
      expect(await call({ action: 'delete', kind: 'skill', name: 'lexicon', path: 'a.md' })).toBe(
        'Deleted skill "lexicon" (a.md). Clients supporting MCP skills get it as skill://lexicon/SKILL.md; the others get the prompt "lexicon", carrying SKILL.md only.',
      );
      expect(await call({ action: 'delete', kind: 'skill', name: 'lexicon' })).toBe(
        'Deleted skill "lexicon". It leaves the prompt menu of clients that refresh their prompt list.',
      );
      expect(service.current().skills.size).toBe(0);
      expect(await call({ action: 'delete', kind: 'prompt', name: 'draft-reply' })).toBe(
        'Deleted prompt "draft-reply". It leaves the prompt menu of clients that refresh their prompt list.',
      );
    });

    it('needs the content, and a description for a prompt', async () => {
      await expect(call({ action: 'set', kind: 'instructions', name: 'global' })).rejects.toThrow(
        'content is required here. Nothing was changed.',
      );
      await expect(
        call({ action: 'set', kind: 'prompt', name: 'x', content: 'x' }),
      ).rejects.toThrow('description is required here.');
      await expect(
        call({ action: 'set', kind: 'instructions', name: 'global', content: '' }),
      ).rejects.toThrow('content is required here.');
    });

    it('refuses to change the built-in context', async () => {
      await expect(
        call({ action: 'set', kind: 'built_in', name: 'instructions', content: 'x' }),
      ).rejects.toThrow(
        'The built-in context is read only: it comes from the server and Zendesk. Nothing was changed.',
      );
    });

    it('lets a failure that is not a refused edit through as it is', async () => {
      vi.spyOn(service, 'edit').mockRejectedValueOnce(new Error('disk full'));
      await expect(
        call({ action: 'set', kind: 'instructions', name: 'global', content: 'x' }),
      ).rejects.toThrow(/^disk full$/);
    });
  });
});

describe('createAdminServer', () => {
  it('serves the tool, the setup prompt and the setup skill, ending the grant on a Zendesk 401', async () => {
    const onUnauthorized = vi.fn();
    const server = createAdminServer({
      env: { config, service },
      readOnly: false,
      tools: createAdminTools({ config, service }),
      setupSkill: await loadSetupSkill(),
      caller,
      requestStateCodec: createRequestStateCodec({}),
      onUnauthorized,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientTransport);

    expect(client.getInstructions()).toContain('Start with the "setup" prompt');
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['manage_customizations']);
    const setup = await client.getPrompt({ name: 'setup' });
    expect(setup.messages[0]?.content).toHaveProperty('text', SETUP_BODY);
    const resource = await client.readResource({ uri: 'skill://setup/SKILL.md' });
    expect((resource.contents[0] as { text: string }).text).toContain('name: setup');

    mswServer.use(http.get(ME, () => new HttpResponse('unauthorized', { status: 401 })));
    const failed = await client.callTool({
      name: 'manage_customizations',
      arguments: { action: 'list' },
    });
    expect(failed.isError).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    mswServer.use(http.get(ME, () => new HttpResponse('boom', { status: 500 })));
    await client.callTool({ name: 'manage_customizations', arguments: { action: 'list' } });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await client.close();
    await server.close();
  });

  it('leaves the write tool out of a read-only server, keeping the setup guide', async () => {
    const server = createAdminServer({
      env: { config, service },
      readOnly: true,
      tools: createAdminTools({ config, service }),
      setupSkill: await loadSetupSkill(),
      caller,
      requestStateCodec: createRequestStateCodec({}),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(clientTransport);
    expect(client.getServerCapabilities()?.tools).toBeUndefined();
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(['setup']);
    await client.close();
    await server.close();
  });

  it('loads the setup skill once per process', async () => {
    expect(await loadSetupSkill()).toBe(await loadSetupSkill());
  });
});
