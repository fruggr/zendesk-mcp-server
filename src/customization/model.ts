import { Namespace } from '../config';
import type { ChangeAuthor, FileChange, StoredTree } from './backend';

/** `global` reaches every session; a namespace's own reaches the sessions that expose it. */
export const INSTRUCTION_SCOPES = ['global', ...Namespace.options] as const;
export type InstructionScope = (typeof INSTRUCTION_SCOPES)[number];

/** Per scope, and for all scopes together: what one session can receive at most. */
export const INSTRUCTION_MAX_CHARS = 4000;
export const INSTRUCTIONS_TOTAL_MAX_CHARS = 12_000;
export const PROMPT_MAX_CHARS = 32_000;
export const SKILL_FILE_MAX_CHARS = 64_000;
export const SKILL_MAX_FILES = 32;
export const SKILL_TOTAL_MAX_CHARS = 256_000;

// The Agent Skills naming rule, applied to prompts too: one name space for both,
// since every skill is also served as a prompt of the same name.
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const PATH_MAX_DEPTH = 4;
export const SKILL_ENTRY_FILE = 'SKILL.md';

export interface InstructionEntry {
  readonly scope: InstructionScope;
  readonly text: string;
  readonly author: ChangeAuthor | undefined;
}

export interface PromptEntry {
  readonly name: string;
  readonly title: string | undefined;
  readonly description: string;
  readonly text: string;
  readonly author: ChangeAuthor | undefined;
}

export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  /** Path inside the skill (`SKILL.md`, `references/lexicon.md`) → text. */
  readonly files: ReadonlyMap<string, string>;
  readonly author: ChangeAuthor | undefined;
}

/** Everything the store holds, parsed: what every session is served from. */
export interface Customizations {
  readonly instructions: ReadonlyMap<InstructionScope, InstructionEntry>;
  readonly prompts: ReadonlyMap<string, PromptEntry>;
  readonly skills: ReadonlyMap<string, SkillEntry>;
  /** Files the store holds but no entry explains: logged, never served. */
  readonly ignored: readonly string[];
}

export const EMPTY_CUSTOMIZATIONS: Customizations = {
  instructions: new Map(),
  prompts: new Map(),
  skills: new Map(),
  ignored: [],
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SINGLE_QUOTED = /^'(.*)'$/;
const LINE_BREAK = /\r?\n/;

// A double-quoted value is the JSON string `planPrompt` writes; YAML's single
// quotes escape a quote by doubling it.
const unquote = (value: string): string => {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value;
    }
  }
  const single = SINGLE_QUOTED.exec(value);
  return single ? (single[1] ?? '').replaceAll("''", "'") : value;
};

/**
 * The `key: value` lines of a leading `---` block and the body after it. Only
 * single-line values: a YAML block scalar reads as its indicator, and a skill
 * using one is refused at write time rather than served half-parsed.
 */
export const parseFrontmatter = (text: string): { fields: Map<string, string>; body: string } => {
  const match = FRONTMATTER.exec(text);
  if (!match) return { fields: new Map(), body: text };
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split(LINE_BREAK)) {
    const colon = line.indexOf(':');
    if (colon <= 0 || line.startsWith(' ')) continue;
    const value = line.slice(colon + 1).trim();
    fields.set(line.slice(0, colon).trim(), unquote(value));
  }
  return { fields, body: text.slice(match[0].length) };
};

const yamlValue = (value: string): string => JSON.stringify(value);

const isScope = (value: string): value is InstructionScope =>
  (INSTRUCTION_SCOPES as readonly string[]).includes(value);

const MARKDOWN = '.md';

/** The scope a top-level `instructions/<scope>.md` holds, if it is one. */
const instructionScopeOf = (name: string): InstructionScope | undefined => {
  const scope = name.endsWith(MARKDOWN) ? name.slice(0, -MARKDOWN.length) : '';
  return isScope(scope) ? scope : undefined;
};

const parsePrompt = (
  name: string,
  text: string,
  author: ChangeAuthor | undefined,
): PromptEntry | undefined => {
  const promptName = name.endsWith(MARKDOWN) ? name.slice(0, -MARKDOWN.length) : '';
  const { fields, body } = parseFrontmatter(text);
  const description = fields.get('description');
  if (!(NAME.test(promptName) && description)) return undefined;
  return { name: promptName, title: fields.get('title'), description, text: body.trim(), author };
};

/** Turns the stored tree into entries; anything unexpected is listed, not served. */
export const parseCustomizations = (tree: StoredTree): Customizations => {
  const instructions = new Map<InstructionScope, InstructionEntry>();
  const prompts = new Map<string, PromptEntry>();
  const skillFiles = new Map<string, Map<string, string>>();
  const ignored: string[] = [];
  // Each kind takes the paths it recognizes, and says so.
  const takers: Record<
    string,
    (name: string, rest: string[], text: string, author: ChangeAuthor | undefined) => boolean
  > = {
    instructions: (name, rest, text, author) => {
      const scope = rest.length === 0 ? instructionScopeOf(name) : undefined;
      if (!scope || text.trim() === '') return false;
      instructions.set(scope, { scope, text: text.trim(), author });
      return true;
    },
    prompts: (name, rest, text, author) => {
      const prompt = rest.length === 0 ? parsePrompt(name, text, author) : undefined;
      if (!prompt) return false;
      prompts.set(prompt.name, prompt);
      return true;
    },
    skills: (name, rest, text) => {
      if (!NAME.test(name) || rest.length === 0) return false;
      const files = skillFiles.get(name) ?? new Map<string, string>();
      files.set(rest.join('/'), text);
      skillFiles.set(name, files);
      return true;
    },
  };
  for (const [path, text] of tree.files) {
    const [kind = '', name = '', ...rest] = path.split('/');
    const taken =
      Object.hasOwn(takers, kind) && takers[kind]?.(name, rest, text, tree.authors.get(path));
    if (!taken) ignored.push(path);
  }
  const skills = new Map<string, SkillEntry>();
  for (const [name, files] of skillFiles) {
    const entry = files.get(SKILL_ENTRY_FILE);
    const description = entry ? parseFrontmatter(entry).fields.get('description') : undefined;
    if (!description || prompts.has(name)) {
      ignored.push(...[...files.keys()].map((file) => `skills/${name}/${file}`));
      continue;
    }
    skills.set(name, {
      name,
      description,
      files,
      author: tree.authors.get(`skills/${name}/${SKILL_ENTRY_FILE}`),
    });
  }
  return { instructions, prompts, skills, ignored };
};

export type CustomizationError = Error & { readonly name: 'CustomizationError' };

export const isCustomizationError = (err: unknown): err is CustomizationError =>
  err instanceof Error && err.name === 'CustomizationError';

/** A refused edit names the rule it breaks, so the model can fix the call. */
export const customizationError = (message: string): CustomizationError =>
  Object.assign(new Error(message), { name: 'CustomizationError' as const });

const fail = (message: string): never => {
  throw customizationError(message);
};

const checkName = (name: string, what: string): void => {
  if (name.length > NAME_MAX || !NAME.test(name)) {
    fail(
      `Invalid ${what} name "${name}": use lowercase letters, digits and single hyphens (e.g. draft-reply), at most ${NAME_MAX} characters.`,
    );
  }
};

const checkLength = (text: string, max: number, what: string): void => {
  if (text.length > max) fail(`${what} is ${text.length} characters long; the limit is ${max}.`);
};

const checkSkillPath = (path: string): void => {
  const segments = path.split('/');
  if (segments.length > PATH_MAX_DEPTH || !segments.every((s) => PATH_SEGMENT.test(s))) {
    fail(
      `Invalid skill file path "${path}": use relative, /-separated names of letters, digits, dots, hyphens and underscores (e.g. references/lexicon.md), at most ${PATH_MAX_DEPTH} levels deep.`,
    );
  }
};

export type CustomizationEdit =
  | { kind: 'instructions'; scope: InstructionScope; text: string | null }
  | {
      kind: 'prompt';
      name: string;
      prompt: { title?: string; description: string; text: string } | null;
    }
  | { kind: 'skill'; name: string; path?: string; text: string | null };

const instructionsTotal = (current: Customizations, scope: InstructionScope, text: string) =>
  [...current.instructions.values()]
    .filter((entry) => entry.scope !== scope)
    .reduce((sum, entry) => sum + entry.text.length, text.length);

const planInstructions = (
  current: Customizations,
  scope: InstructionScope,
  text: string | null,
): FileChange[] => {
  const path = `instructions/${scope}.md`;
  if (text === null) {
    if (!current.instructions.has(scope)) fail(`No instructions are set for "${scope}".`);
    return [{ path, content: null }];
  }
  const trimmed = text.trim();
  if (trimmed === '') fail('The instructions are empty; delete them instead.');
  checkLength(trimmed, INSTRUCTION_MAX_CHARS, `The "${scope}" instructions`);
  const total = instructionsTotal(current, scope, trimmed);
  if (total > INSTRUCTIONS_TOTAL_MAX_CHARS) {
    fail(
      `All instructions together would be ${total} characters long; the limit is ${INSTRUCTIONS_TOTAL_MAX_CHARS}, since every session receives them. Shorten them, or move reference material into a skill.`,
    );
  }
  return [{ path, content: `${trimmed}\n` }];
};

const planPrompt = (
  current: Customizations,
  name: string,
  prompt: { title?: string; description: string; text: string } | null,
): FileChange[] => {
  checkName(name, 'prompt');
  const path = `prompts/${name}.md`;
  if (prompt === null) {
    if (!current.prompts.has(name)) fail(`No prompt is named "${name}".`);
    return [{ path, content: null }];
  }
  if (current.skills.has(name)) {
    fail(`A skill is already named "${name}", and every skill is served as a prompt of its name.`);
  }
  const description = prompt.description.trim();
  const text = prompt.text.trim();
  if (description === '' || description.includes('\n')) {
    fail('A prompt needs a one-line description: it is what clients show in their prompt menu.');
  }
  if (text === '') fail('The prompt text is empty.');
  checkLength(text, PROMPT_MAX_CHARS, 'The prompt text');
  const title = prompt.title?.trim();
  const header = [
    ...(title ? [`title: ${yamlValue(title)}`] : []),
    `description: ${yamlValue(description)}`,
  ];
  return [{ path, content: `---\n${header.join('\n')}\n---\n\n${text}\n` }];
};

const checkSkillEntry = (name: string, text: string): void => {
  const { fields, body } = parseFrontmatter(text);
  if (fields.get('name') !== name) {
    fail(
      `SKILL.md must start with a frontmatter block whose name is "${name}" (---, name: ${name}, description: ..., ---).`,
    );
  }
  const description = fields.get('description') ?? '';
  if (description === '' || ['>', '|', '>-', '|-'].includes(description)) {
    fail(
      'SKILL.md needs a one-line description in its frontmatter: it decides when a client loads the skill.',
    );
  }
  if (body.trim() === '') fail('SKILL.md has no instructions after its frontmatter.');
};

const planSkill = (
  current: Customizations,
  name: string,
  path: string | undefined,
  text: string | null,
): FileChange[] => {
  checkName(name, 'skill');
  const skill = current.skills.get(name);
  const file = path ?? SKILL_ENTRY_FILE;
  checkSkillPath(file);
  if (text === null) {
    if (!skill) fail(`No skill is named "${name}".`);
    // Without a path, or naming SKILL.md, the whole skill goes.
    if (file === SKILL_ENTRY_FILE) {
      return [...(skill?.files.keys() ?? [])].map((f) => ({
        path: `skills/${name}/${f}`,
        content: null,
      }));
    }
    if (!skill?.files.has(file)) fail(`The skill "${name}" has no file "${file}".`);
    return [{ path: `skills/${name}/${file}`, content: null }];
  }
  if (current.prompts.has(name)) {
    fail(
      `A prompt is already named "${name}", and every skill is also served as a prompt of its name.`,
    );
  }
  if (file === SKILL_ENTRY_FILE) checkSkillEntry(name, text);
  else if (!skill) fail(`Create the skill's ${SKILL_ENTRY_FILE} first, then add "${file}".`);
  checkLength(text, SKILL_FILE_MAX_CHARS, `The file "${file}"`);
  const files = new Map(skill?.files ?? []);
  files.set(file, text);
  if (files.size > SKILL_MAX_FILES) fail(`A skill holds at most ${SKILL_MAX_FILES} files.`);
  const total = [...files.values()].reduce((sum, f) => sum + f.length, 0);
  if (total > SKILL_TOTAL_MAX_CHARS) {
    fail(`The skill would hold ${total} characters; the limit is ${SKILL_TOTAL_MAX_CHARS}.`);
  }
  return [{ path: `skills/${name}/${file}`, content: text }];
};

/** The file changes an edit makes, or a `CustomizationError` naming the rule it breaks. */
export const planEdit = (current: Customizations, edit: CustomizationEdit): FileChange[] => {
  if (edit.kind === 'instructions') return planInstructions(current, edit.scope, edit.text);
  if (edit.kind === 'prompt') return planPrompt(current, edit.name, edit.prompt);
  return planSkill(current, edit.name, edit.path, edit.text);
};
