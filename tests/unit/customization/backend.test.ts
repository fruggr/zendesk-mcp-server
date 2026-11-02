import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CustomizationBackend,
  createFileBackend,
  createMemoryBackend,
  openCustomizationBackend,
} from '../../../src/customization/backend';

const ADA = { name: 'Ada (Zendesk user 1)', at: '2026-11-01T10:00:00.000Z' };
const BOB = { name: 'Bob (Zendesk user 2)', at: '2026-11-02T10:00:00.000Z' };

const contract = (name: string, make: () => CustomizationBackend) => {
  describe(`${name} backend contract`, () => {
    it('starts empty', async () => {
      expect(await make().load()).toEqual({ files: new Map(), authors: new Map() });
    });

    it('applies a change set and records who made each change', async () => {
      const backend = make();
      await backend.apply(
        [
          { path: 'instructions/global.md', content: 'Be brief.\n' },
          { path: 'skills/lexicon/references/words.md', content: 'workspace' },
        ],
        ADA,
      );
      await backend.apply([{ path: 'instructions/global.md', content: 'Be kind.\n' }], BOB);
      const { files, authors } = await backend.load();
      expect(Object.fromEntries(files)).toEqual({
        'instructions/global.md': 'Be kind.\n',
        'skills/lexicon/references/words.md': 'workspace',
      });
      expect(Object.fromEntries(authors)).toEqual({
        'instructions/global.md': BOB,
        'skills/lexicon/references/words.md': ADA,
      });
    });

    it('removes a file and its author', async () => {
      const backend = make();
      await backend.apply([{ path: 'prompts/x.md', content: 'x' }], ADA);
      await backend.apply([{ path: 'prompts/x.md', content: null }], BOB);
      expect(await backend.load()).toEqual({ files: new Map(), authors: new Map() });
    });
  });
};

contract('memory', () => createMemoryBackend());

describe('file backend', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'customizations-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  contract('file', () => createFileBackend(join(dir, 'store')));

  it('keeps one readable file per entry, and the authors beside them', async () => {
    const root = join(dir, 'store');
    await createFileBackend(root).apply([{ path: 'prompts/x.md', content: 'Hello\n' }], ADA);
    expect(readFileSync(join(root, 'prompts', 'x.md'), 'utf8')).toBe('Hello\n');
    expect(JSON.parse(readFileSync(join(root, '.authors.json'), 'utf8'))).toEqual({
      'prompts/x.md': ADA,
    });
  });

  describe.skipIf(process.platform === 'win32')('permissions', () => {
    it('keeps the files private to the server', async () => {
      const root = join(dir, 'store');
      await createFileBackend(root).apply([{ path: 'prompts/x.md', content: 'x' }], ADA);
      const mode = statSync(join(root, 'prompts', 'x.md')).mode.toString(8);
      expect(mode.slice(-3)).toBe('600');
    });
  });

  it('ignores the leftovers of an interrupted write, and serves files without an authors record', async () => {
    const root = join(dir, 'store');
    const backend = createFileBackend(root);
    await backend.apply([{ path: 'prompts/x.md', content: 'x' }], ADA);
    writeFileSync(join(root, 'prompts', 'x.md.123.tmp'), 'half');
    writeFileSync(join(root, '.authors.json'), 'not json');
    expect(await backend.load()).toEqual({
      files: new Map([['prompts/x.md', 'x']]),
      authors: new Map(),
    });
  });

  it('refuses a path escaping its root', async () => {
    await expect(
      createFileBackend(join(dir, 'store')).apply([{ path: '../escape.md', content: 'x' }], ADA),
    ).rejects.toThrow('Invalid path: ../escape.md');
  });

  it('is opened from a file:// URI, trailing slash or not', async () => {
    const root = join(dir, 'store');
    await createFileBackend(root).apply([{ path: 'prompts/x.md', content: 'x' }], ADA);
    for (const uri of [pathToFileURL(root).href, `${pathToFileURL(root).href}/`]) {
      expect((await openCustomizationBackend(uri).load()).files.get('prompts/x.md')).toBe('x');
    }
  });
});

describe('openCustomizationBackend', () => {
  it('opens memory://', async () => {
    expect((await openCustomizationBackend('memory://').load()).files.size).toBe(0);
  });

  it('names the schemes it takes when given another', () => {
    expect(() => openCustomizationBackend('redis://host')).toThrow(
      'Unsupported CUSTOMIZATION_STORE "redis://": use file://<directory> or memory://.',
    );
  });
});
