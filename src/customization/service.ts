import { SkillCatalog, type SkillFiles, skillEntry } from '@modelcontextprotocol/server/ext/skills';
import { type Logger, silentLogger } from '../utils/logger';
import type { ChangeAuthor, CustomizationBackend, FileChange } from './backend';
import {
  type CustomizationEdit,
  type Customizations,
  customizationError,
  parseCustomizations,
  planEdit,
  SKILL_ENTRY_FILE,
} from './model';

/**
 * The customizations every server of this process is built from: read from the
 * backend once at startup, then kept in memory and changed only through `edit`,
 * so a server is built synchronously from `current()`.
 */
export interface CustomizationService {
  current(): Customizations;
  /** Validates, stores, then swaps the new state in; edits run one after another. */
  edit(edit: CustomizationEdit, author: ChangeAuthor): Promise<Customizations>;
  /** Called after each edit; returns the unsubscribe. */
  onChange(listener: () => void): () => void;
  /** The admins' skills, served through the Skills extension (SEP-2640). */
  readonly skills: SkillCatalog;
}

const encoder = new TextEncoder();

/**
 * The skills of `state()` as the SDK's storage adapter sees them: one folder
 * per skill at the root. Read live, so `catalog.reload()` picks up an edit.
 */
const skillFiles = (state: () => Customizations): SkillFiles => {
  const paths = (): string[] =>
    [...state().skills.values()].flatMap((skill) =>
      [...skill.files.keys()].map((file) => `${skill.name}/${file}`),
    );
  return {
    list: async (dir) => {
      const prefix = dir === '' ? '' : `${dir}/`;
      const children = new Map<string, 'file' | 'directory'>();
      for (const path of paths()) {
        if (!path.startsWith(prefix)) continue;
        const [name = '', ...rest] = path.slice(prefix.length).split('/');
        children.set(name, rest.length > 0 ? 'directory' : 'file');
      }
      return [...children].map(([name, kind]) => ({ name, kind }));
    },
    read: async (path) => {
      const [name = '', ...rest] = path.split('/');
      const text = state().skills.get(name)?.files.get(rest.join('/'));
      if (text === undefined) throw new Error(`No skill file at ${path}`);
      return encoder.encode(text);
    },
  };
};

/**
 * The skill as it would be after `changes`, checked by the SDK the way the
 * catalog will read it (YAML frontmatter, name matching the folder): a skill
 * it would skip is refused now, with its reason, rather than silently dropped.
 */
const checkSkill = async (
  state: Customizations,
  name: string,
  changes: readonly FileChange[],
): Promise<void> => {
  const files = new Map(state.skills.get(name)?.files ?? []);
  for (const { path, content } of changes) {
    const file = path.slice(`skills/${name}/`.length);
    if (content === null) files.delete(file);
    else files.set(file, content);
  }
  try {
    await skillEntry(name, Object.fromEntries(files));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw customizationError(
      `The skill would not be served: ${reason} (${SKILL_ENTRY_FILE} frontmatter is YAML: quote a value holding ": ").`,
    );
  }
};

export const createCustomizationService = async (
  backend: CustomizationBackend,
  logger: Logger = silentLogger,
): Promise<CustomizationService> => {
  const load = async (): Promise<Customizations> => {
    const state = parseCustomizations(await backend.load());
    if (state.ignored.length > 0) {
      logger.warn('customizations_ignored', {
        files: state.ignored,
        hint: 'Files the customization store holds but serves nothing for: a malformed entry, or a file placed by hand.',
      });
    }
    return state;
  };
  let state = await load();
  const listeners = new Set<() => void>();
  const skills = await SkillCatalog.load(
    skillFiles(() => state),
    {
      // An empty catalog is warned about too: that is no skill yet, not a problem.
      onWarning: (warning) => {
        if (state.skills.size > 0) logger.warn('customization_skill_skipped', { ...warning });
      },
    },
  );
  let queue: Promise<unknown> = Promise.resolve();

  const apply = async (edit: CustomizationEdit, author: ChangeAuthor) => {
    const changes = planEdit(state, edit);
    if (edit.kind === 'skill' && edit.text !== null) await checkSkill(state, edit.name, changes);
    let failure: { error: unknown } | undefined;
    try {
      await backend.apply(changes, author);
    } catch (error) {
      failure = { error };
    }
    // Re-read rather than patch, after a failed change set too (a file backend
    // may have applied part of it): what is served is exactly what the store
    // holds, everywhere, before the write's own error is reported.
    state = await load();
    await skills.reload();
    for (const listener of listeners) listener();
    if (failure) throw failure.error;
    return state;
  };

  return {
    current: () => state,
    edit: (edit, author) => {
      const run = queue.then(() => apply(edit, author));
      queue = run.catch(() => undefined);
      return run;
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    skills,
  };
};
