import { describe, expect, it, vi } from 'vitest';
import {
  type ChangeAuthor,
  type CustomizationBackend,
  createMemoryBackend,
} from '../../../src/customization/backend';
import { isCustomizationError } from '../../../src/customization/model';
import { createCustomizationService } from '../../../src/customization/service';
import type { Logger } from '../../../src/utils/logger';

const ADA: ChangeAuthor = { name: 'Ada', at: '2026-11-01T10:00:00.000Z' };
const SKILL = '---\nname: lexicon\ndescription: "Our words: use them."\n---\n\nSay workspace.\n';

const recording = () => {
  const events: [string, unknown][] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (event, fields) => events.push([event, fields]),
    error: () => undefined,
  };
  return { logger, events };
};

describe('createCustomizationService', () => {
  it('serves what the store holds, and warns once about what it cannot serve', async () => {
    const { logger, events } = recording();
    const service = await createCustomizationService(
      createMemoryBackend({ 'instructions/global.md': 'Be brief.', 'stray.txt': 'x' }),
      logger,
    );
    expect(service.current().instructions.get('global')?.text).toBe('Be brief.');
    expect(events).toEqual([
      [
        'customizations_ignored',
        {
          files: ['stray.txt'],
          hint: 'Files the customization store holds but serves nothing for: a malformed entry, or a file placed by hand.',
        },
      ],
    ]);
  });

  it('stores an edit with its author, then serves it and tells the listeners', async () => {
    const backend = createMemoryBackend();
    const service = await createCustomizationService(backend);
    const listener = vi.fn();
    const unsubscribe = service.onChange(listener);
    const next = await service.edit(
      { kind: 'instructions', scope: 'tickets', text: 'Tag it.' },
      ADA,
    );
    expect(next.instructions.get('tickets')).toEqual({
      scope: 'tickets',
      text: 'Tag it.',
      author: ADA,
    });
    expect(service.current()).toBe(next);
    expect((await backend.load()).files.get('instructions/tickets.md')).toBe('Tag it.\n');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await service.edit({ kind: 'instructions', scope: 'tickets', text: null }, ADA);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('runs edits one after another, each planned on the state the previous one left', async () => {
    const service = await createCustomizationService(createMemoryBackend());
    const prompt = { description: 'd', text: 'x' };
    const [first, second] = await Promise.allSettled([
      service.edit({ kind: 'prompt', name: 'lexicon', prompt }, ADA),
      service.edit({ kind: 'skill', name: 'lexicon', text: SKILL }, ADA),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status === 'rejected' && second.reason.message).toBe(
      'A prompt is already named "lexicon", and every skill is also served as a prompt of its name.',
    );
    // A refused edit does not block the next one.
    await service.edit({ kind: 'instructions', scope: 'global', text: 'ok' }, ADA);
    expect(service.current().instructions.size).toBe(1);
  });

  it('refuses a skill the catalog would skip, with the reason, and stores nothing', async () => {
    const backend = createMemoryBackend();
    const apply = vi.spyOn(backend, 'apply');
    const service = await createCustomizationService(backend);
    const edit = service.edit(
      {
        kind: 'skill',
        name: 'lexicon',
        text: '---\nname: lexicon\ndescription: Our words: use them.\n---\nSay workspace.',
      },
      ADA,
    );
    await expect(edit).rejects.toSatisfy(isCustomizationError);
    await expect(edit).rejects.toThrow(
      'The skill would not be served: 1 skill problem:\n  lexicon: SKILL.md frontmatter: line 3: a plain value cannot contain ": "; quote the value (SKILL.md frontmatter is YAML: quote a value holding ": ").',
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it('serves an added skill through its catalog, and drops a deleted one', async () => {
    const service = await createCustomizationService(createMemoryBackend());
    expect(service.skills.entries).toEqual([]);
    await service.edit({ kind: 'skill', name: 'lexicon', text: SKILL }, ADA);
    await service.edit(
      { kind: 'skill', name: 'lexicon', path: 'references/words.md', text: 'w' },
      ADA,
    );
    expect(service.skills.entries.map((entry) => entry.uri)).toEqual(['skill://lexicon/SKILL.md']);
    expect(service.skills.entries[0]?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: 'skill://lexicon/SKILL.md' }),
        expect.objectContaining({ uri: 'skill://lexicon/references/words.md' }),
      ]),
    );
    await service.edit({ kind: 'skill', name: 'lexicon', text: null }, ADA);
    expect(service.skills.entries).toEqual([]);
  });

  it('keeps serving the last good state when the store fails to write', async () => {
    const backend: CustomizationBackend = {
      ...createMemoryBackend(),
      apply: async () => {
        throw new Error('disk full');
      },
    };
    const service = await createCustomizationService(backend);
    await expect(
      service.edit({ kind: 'instructions', scope: 'global', text: 'x' }, ADA),
    ).rejects.toThrow('disk full');
    expect(service.current().instructions.size).toBe(0);
  });
});
