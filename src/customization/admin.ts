import { McpServer, type RequestStateCodec } from '@modelcontextprotocol/server';
import { memorySkillFiles, SkillCatalog } from '@modelcontextprotocol/server/ext/skills';
import * as z from 'zod/v4';
import { ZENDESK_ADMIN_ROLE } from '../auth/server/upstream';
import { ZendeskApiError, zendeskGet } from '../client/zendesk-api';
import type { Config } from '../config';
import { buildInstructions } from '../guidance/instructions';
import { createTopologyProvider, type TopologyProvider } from '../guidance/topology';
import type { ToolAnnotations, ToolResult } from '../tools/definitions';
import { compareCodeUnits } from '../utils/compare';
import { readPackageInfo } from '../utils/package-info';
import { toStrictStandardSchema } from '../utils/validation';
import type { ChangeAuthor } from './backend';
import {
  type CustomizationEdit,
  type Customizations,
  customizationError,
  INSTRUCTION_MAX_CHARS,
  INSTRUCTION_SCOPES,
  INSTRUCTIONS_TOTAL_MAX_CHARS,
  type InstructionScope,
  isCustomizationError,
  PROMPT_MAX_CHARS,
  SKILL_ENTRY_FILE,
} from './model';
import { buildCustomInstructions, DERIVED_PROMPT_MAX_CHARS, skillUri } from './serve';
import type { CustomizationService } from './service';
import { SETUP_BODY, SETUP_DESCRIPTION, SETUP_NAME, SETUP_SKILL } from './setup';

/** What the admin tool needs about the caller, built per server. */
export interface AdminCaller {
  getToken: () => string | Promise<string>;
}

/** What the admin tool acts on: the store, and the `/mcp` surface it customizes. */
export interface AdminEnv {
  /** The `/mcp` config: what its sessions receive is what the admin is shown. */
  config: Config;
  service: CustomizationService;
}

/** The back-office tools: not Zendesk tools, so not in `createAllTools`. */
export interface AdminToolDefinition {
  name: string;
  readOnly: boolean;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  handler: (params: Record<string, unknown>, caller: AdminCaller) => Promise<ToolResult>;
}

const ADMIN_ONLY =
  'This back-office is reserved for Zendesk administrators: your Zendesk role is not admin.';

interface ZendeskMe {
  user: { id: number; name?: string; role?: string };
}

/**
 * The caller, re-read from Zendesk on every call: a token minted for an admin
 * stays valid up to an hour after a demotion, this check does not.
 */
export const requireAdmin = async (
  subdomain: string,
  getToken: () => string | Promise<string>,
): Promise<{ id: number; name: string }> => {
  const { user } = await zendeskGet<ZendeskMe>(subdomain, await getToken(), '/users/me');
  if (user.role !== ZENDESK_ADMIN_ROLE) throw new Error(ADMIN_ONLY);
  return { id: user.id, name: user.name ?? `user ${user.id}` };
};

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });

const describeAuthor = (author: ChangeAuthor | undefined): string =>
  author ? `, last changed by ${author.name} on ${author.at.slice(0, 10)}` : '';

/** What a new `/mcp` session receives as `instructions`, built-in part first. */
export const effectiveInstructions = (config: Config, state: Customizations): string =>
  [buildInstructions(config), buildCustomInstructions(state, config)]
    .filter((block): block is string => block !== undefined)
    .join('\n\n') || '(none)';

const listCustomizations = (env: AdminEnv): string => {
  const state = env.service.current();
  const lines = [
    '## Built in (read only, sent by the server on its own)',
    '- instructions: what every session already receives. Read it with action "get", kind "built_in", name "instructions".',
    '- topology: the Help Center structure (locales, categories and sections with ids, segments, permission groups, the caller\'s role), served to every session as a resource. Read it with kind "built_in", name "topology".',
    '',
    '## Instructions',
    ...(state.instructions.size === 0
      ? ['(none)']
      : [...state.instructions.values()].map(
          (entry) =>
            `- ${entry.scope}: ${entry.text.length} characters${describeAuthor(entry.author)}`,
        )),
    '',
    '## Prompts',
    ...(state.prompts.size === 0
      ? ['(none)']
      : [...state.prompts.values()].map(
          (prompt) => `- ${prompt.name}: ${prompt.description}${describeAuthor(prompt.author)}`,
        )),
    '',
    '## Skills',
    ...(state.skills.size === 0
      ? ['(none)']
      : [...state.skills.values()].map(
          (skill) =>
            `- ${skill.name}: ${skill.description} (files: ${sorted(skill.files)})${describeAuthor(skill.author)}`,
        )),
    '',
    `Limits: ${INSTRUCTION_MAX_CHARS} characters per instructions scope and ${INSTRUCTIONS_TOTAL_MAX_CHARS} for all of them; ${PROMPT_MAX_CHARS} per prompt; a skill's derived prompt carries the first ${DERIVED_PROMPT_MAX_CHARS} characters of its SKILL.md.`,
  ];
  return lines.join('\n');
};

const ACTIONS = ['list', 'get', 'set', 'delete'] as const;
const KINDS = ['instructions', 'prompt', 'skill', 'built_in'] as const;
const BUILT_IN = ['instructions', 'topology'] as const;
type Kind = (typeof KINDS)[number];

const inputSchema = z.object({
  action: z
    .enum(ACTIONS)
    .describe(
      'list: everything configured plus the built-in context; get: read one entry; set: create or replace one entry; delete: remove one entry.',
    ),
  kind: z
    .enum(KINDS)
    .optional()
    .describe(
      'What the entry is: instructions (always-on text every matching session receives), prompt (a workflow users start from their prompt menu), skill (a SKILL.md, plus optional files, the assistant loads when a task matches), or built_in (what the server already sends, read only). Required except for list.',
    ),
  name: z
    .string()
    .optional()
    .describe(
      `Which entry. For instructions, the scope: ${INSTRUCTION_SCOPES.join(', ')} (global reaches every session, a namespace only sessions exposing it). For prompts and skills, a lowercase-hyphenated name such as draft-reply, shared by both kinds. For built_in: instructions or topology. Required except for list.`,
    ),
  path: z
    .string()
    .optional()
    .describe(
      `Skills only: the file inside the skill, such as references/lexicon.md. Defaults to ${SKILL_ENTRY_FILE}; deleting ${SKILL_ENTRY_FILE} (or giving no path) deletes the whole skill.`,
    ),
  content: z
    .string()
    .optional()
    .describe(
      `For set: the full new text, replacing the old one. Instructions and prompts are plain Markdown; a skill's ${SKILL_ENTRY_FILE} starts with a YAML frontmatter block holding name (the skill name) and a one-line description (quoted if it contains ": ").`,
    ),
  description: z
    .string()
    .optional()
    .describe(
      'For set on a prompt: the one-line description clients show in their prompt menu. Required there.',
    ),
  title: z
    .string()
    .optional()
    .describe('For set on a prompt: an optional human-readable title shown instead of the name.'),
});

type Params = z.infer<typeof inputSchema>;

const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined || value === '') throw customizationError(`${what} is required here.`);
  return value;
};

const asScope = (name: string): InstructionScope => {
  if (!(INSTRUCTION_SCOPES as readonly string[]).includes(name)) {
    throw customizationError(
      `Unknown instructions scope "${name}": use one of ${INSTRUCTION_SCOPES.join(', ')}.`,
    );
  }
  return name as InstructionScope;
};

const sorted = (files: ReadonlyMap<string, string>): string =>
  [...files.keys()].sort(compareCodeUnits).join(', ');

type Reader = (
  env: AdminEnv,
  name: string,
  params: Params,
  topology: () => TopologyProvider,
) => string | Promise<string>;

const READERS: Record<Kind, Reader> = {
  built_in: (env, name, _params, topology) => {
    if (name === 'instructions') return buildInstructions(env.config) ?? '(none)';
    if (name === 'topology') return topology().read();
    throw customizationError(`Unknown built-in "${name}": use ${BUILT_IN.join(' or ')}.`);
  },
  instructions: (env, name) =>
    env.service.current().instructions.get(asScope(name))?.text ??
    `No instructions are set for "${name}".`,
  prompt: (env, name) => {
    const prompt = env.service.current().prompts.get(name);
    if (!prompt) return `No prompt is named "${name}".`;
    const title = prompt.title ? [`Title: ${prompt.title}`] : [];
    return [...title, `Description: ${prompt.description}`, '', prompt.text].join('\n');
  },
  skill: (env, name, params) => {
    const skill = env.service.current().skills.get(name);
    if (!skill) return `No skill is named "${name}".`;
    const path = params.path ?? SKILL_ENTRY_FILE;
    const file = skill.files.get(path);
    if (file === undefined) return `The skill "${name}" has no file "${path}".`;
    return `Files: ${sorted(skill.files)}\nURI: ${skillUri(name, path)}\n\n${file}`;
  },
};

const getEntry = (env: AdminEnv, params: Params, topology: () => TopologyProvider) =>
  READERS[required(params.kind, 'kind')](env, required(params.name, 'name'), params, topology);

type EditBuilder = (name: string, content: string | null, params: Params) => CustomizationEdit;

const EDITS: Record<Kind, EditBuilder> = {
  instructions: (name, content) => ({ kind: 'instructions', scope: asScope(name), text: content }),
  prompt: (name, content, params) => ({
    kind: 'prompt',
    name,
    prompt:
      content === null
        ? null
        : {
            description: required(params.description, 'description'),
            text: content,
            ...(params.title === undefined ? {} : { title: params.title }),
          },
  }),
  skill: (name, content, params) => ({
    kind: 'skill',
    name,
    ...(params.path === undefined ? {} : { path: params.path }),
    text: content,
  }),
  built_in: () => {
    throw customizationError(
      'The built-in context is read only: it comes from the server and Zendesk.',
    );
  },
};

const toEdit = (params: Params, deleting: boolean): CustomizationEdit =>
  EDITS[required(params.kind, 'kind')](
    required(params.name, 'name'),
    deleting ? null : required(params.content, 'content'),
    params,
  );

const confirm = (
  env: AdminEnv,
  params: Params,
  deleting: boolean,
  state: Customizations,
): string => {
  const done = deleting ? 'Deleted' : 'Saved';
  const what = `${params.kind} "${params.name}"${params.path ? ` (${params.path})` : ''}`;
  if (params.kind === 'instructions') {
    return `${done} ${what}. A new session on /mcp now receives these instructions (the built-in part first); check them for repetitions and contradictions:\n\n${effectiveInstructions(env.config, state)}`;
  }
  const name = params.name ?? '';
  if (params.kind === 'skill' && state.skills.has(name)) {
    return `${done} ${what}. Clients supporting MCP skills get it as ${skillUri(name)}; the others get the prompt "${name}", carrying ${SKILL_ENTRY_FILE} only.`;
  }
  if (deleting) {
    return `${done} ${what}. It leaves the prompt menu of clients that refresh their prompt list.`;
  }
  return `${done} ${what}. It appears in the prompt menu of clients that refresh their prompt list.`;
};

export const createAdminTools = (env: AdminEnv): AdminToolDefinition[] => {
  // One provider per tool set: its cache would otherwise outlive the caller.
  const topologyFor = (caller: AdminCaller) => () =>
    createTopologyProvider(caller.getToken, env.config.subdomain, undefined, env.config.brandIds);
  return [
    {
      name: 'manage_customizations',
      // Unlike a user's own preferences, this changes what every user gets: a
      // read-only server or a `read`-only sign-in must not reach it.
      readOnly: false,
      title: 'Manage Team Customizations',
      description:
        "Read and change what this MCP server teaches every user's assistant on /mcp: instructions (always-on text), prompts (workflows users start from their prompt menu) and skills (SKILL.md files the assistant loads when a task matches). list shows them all with who changed each, plus the built-in context the server already sends; get reads one entry, or the built-in instructions and Help Center topology; set creates or replaces an entry; delete removes one. Writes go to this server's store, never to Zendesk. Reserved for Zendesk admins, checked on every call. Before setting anything, read the built-in context and do not repeat it; the setup prompt walks through the whole configuration.",
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async (raw, caller) => {
        const params = raw as Params;
        const admin = await requireAdmin(env.config.subdomain, caller.getToken);
        try {
          if (params.action === 'list') return text(listCustomizations(env));
          if (params.action === 'get')
            return text(await getEntry(env, params, topologyFor(caller)));
          const deleting = params.action === 'delete';
          const state = await env.service.edit(toEdit(params, deleting), {
            name: `${admin.name} (Zendesk user ${admin.id})`,
            at: new Date().toISOString(),
          });
          return text(confirm(env, params, deleting, state));
        } catch (err) {
          // A refused edit is the model's to fix: its message says how.
          if (isCustomizationError(err)) {
            throw new Error(`${err.message} Nothing was changed.`, { cause: err });
          }
          throw err;
        }
      },
    },
  ];
};

const ADMIN_INSTRUCTIONS = `This is the back-office of the Zendesk MCP server, reserved for Zendesk admins. It configures what the server teaches every user's assistant on its main endpoint: instructions, prompts and skills. Start with the "${SETUP_NAME}" prompt, or the skill of the same name: it reads what already exists and guides each change.`;

/** The `setup` guide as a skill, the same for every admin: built once per process. */
let setupSkills: Promise<SkillCatalog> | undefined;
export const loadSetupSkill = (): Promise<SkillCatalog> => {
  setupSkills ??= SkillCatalog.load(
    memorySkillFiles({ [`${SETUP_NAME}/${SKILL_ENTRY_FILE}`]: SETUP_SKILL }),
  );
  return setupSkills;
};

export interface AdminServerParams {
  env: AdminEnv;
  /** `--read-only`, or a sign-in without `write`: the write tools are left out. */
  readOnly: boolean;
  tools: readonly AdminToolDefinition[];
  setupSkill: SkillCatalog;
  caller: AdminCaller;
  requestStateCodec: RequestStateCodec;
  onUnauthorized?: (() => void) | undefined;
}

/** One `/mcp/admin` server: the admin tools, the `setup` prompt and skill, nothing of Zendesk's. */
export const createAdminServer = ({
  readOnly,
  tools,
  setupSkill,
  caller,
  requestStateCodec,
  onUnauthorized,
}: AdminServerParams): McpServer => {
  const pkg = readPackageInfo();
  const server = new McpServer(
    { name: pkg.name, version: pkg.version },
    {
      instructions: ADMIN_INSTRUCTIONS,
      requestState: { verify: (state, ctx) => requestStateCodec.verify(state, ctx) },
    },
  );
  for (const tool of tools.filter((t) => t.readOnly || !readOnly)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: toStrictStandardSchema(tool.inputSchema),
        annotations: tool.annotations,
      },
      async (params) => {
        try {
          return await tool.handler(params as Record<string, unknown>, caller);
        } catch (err) {
          // Zendesk refused the token: end the grant, as a /mcp tool call does.
          if (err instanceof ZendeskApiError && err.status === 401) onUnauthorized?.();
          throw err;
        }
      },
    );
  }
  server.registerPrompt(
    SETUP_NAME,
    { title: 'Set up the team assistant', description: SETUP_DESCRIPTION },
    () => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: SETUP_BODY } }],
    }),
  );
  setupSkill.attach(server);
  return server;
};
