import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config';
import { compareCodeUnits } from '../utils/compare';
import {
  type Customizations,
  type InstructionScope,
  parseFrontmatter,
  SKILL_ENTRY_FILE,
  type SkillEntry,
} from './model';
import type { CustomizationService } from './service';

/** How much of a skill a derived prompt carries; the rest stays readable as the skill. */
export const DERIVED_PROMPT_MAX_CHARS = 16_000;

const SCOPE_HEADINGS: Record<Exclude<InstructionScope, 'global'>, string> = {
  tickets: 'For tickets',
  help_center: 'For the Help Center',
  users: 'For users and organizations',
  requests: "For customers' requests",
  preferences: 'For connector preferences',
};

/**
 * The admins' instructions a session with `config`'s namespaces receives: the
 * global ones, then each active namespace's, or `undefined` when none apply.
 */
export const buildCustomInstructions = (
  state: Customizations,
  config: Pick<Config, 'namespaces'>,
): string | undefined => {
  const blocks: string[] = [];
  const global = state.instructions.get('global');
  if (global) blocks.push(global.text);
  for (const namespace of config.namespaces) {
    const entry = state.instructions.get(namespace);
    if (entry) blocks.push(`${SCOPE_HEADINGS[namespace]}:\n${entry.text}`);
  }
  if (blocks.length === 0) return undefined;
  return ["Your team's own instructions, set by its Zendesk admins:", ...blocks].join('\n\n');
};

/** Where a client supporting the Skills extension reads the skill. */
export const skillUri = (name: string, file = SKILL_ENTRY_FILE): string =>
  `skill://${name}/${file}`;

/**
 * A skill as a prompt, for clients without the Skills extension. The header is
 * the server's, added on read: it sends a client that has the skill back to it,
 * and tells the others what the conversion dropped.
 */
export const derivedPromptText = (skill: SkillEntry): string => {
  const entry = skill.files.get(SKILL_ENTRY_FILE) ?? '';
  const body = parseFrontmatter(entry).body.trim();
  const truncated = body.length > DERIVED_PROMPT_MAX_CHARS;
  const others = [...skill.files.keys()]
    .filter((file) => file !== SKILL_ENTRY_FILE)
    .sort(compareCodeUnits);
  return [
    `[Note from the MCP server] This prompt is the skill "${skill.name}" (${skillUri(skill.name)}) converted for clients that do not support MCP skills.`,
    `If "${skill.name}" is among the skills available to you, stop reading this prompt: load that skill and follow it instead.`,
    "Otherwise follow the instructions below, knowing the conversion is lossy: the skill's other files are not included and its scripts cannot run here. If something below does not work as it says, that is a limit of this conversion, not a mistake on your side.",
    '',
    '---',
    '',
    truncated
      ? `${body.slice(0, DERIVED_PROMPT_MAX_CHARS)}\n\n[Truncated by the MCP server: the full text is ${skillUri(skill.name)}.]`
      : body,
    ...(others.length > 0
      ? [
          '',
          '---',
          '',
          'Files of this skill not included here (MCP resources, if your client can read them):',
          ...others.map((file) => `- ${skillUri(skill.name, file)}`),
        ]
      : []),
  ].join('\n');
};

const userMessage = (text: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
});

/** The prompts of `state`: the admins' own, then one per skill. Returns the removers. */
const registerPrompts = (server: McpServer, state: Customizations): Array<() => void> => {
  const handles = [
    ...[...state.prompts.values()].map((prompt) =>
      server.registerPrompt(
        prompt.name,
        { ...(prompt.title ? { title: prompt.title } : {}), description: prompt.description },
        () => userMessage(prompt.text),
      ),
    ),
    ...[...state.skills.values()].map((skill) =>
      server.registerPrompt(
        skill.name,
        {
          description: `${skill.description} (The skill "${skill.name}" as a prompt: use the skill itself when your client supports MCP skills.)`,
        },
        () => userMessage(derivedPromptText(skill)),
      ),
    ),
  ];
  return handles.map((handle) => () => handle.remove());
};

/**
 * Serves the customizations on one `/mcp` server: its prompts and the skills.
 * `live` for a server that outlives an edit (a 2025 session): its prompts are
 * swapped in place, which notifies the client; per-request servers are rebuilt.
 */
export const serveCustomizations = (
  server: McpServer,
  service: CustomizationService,
  { live }: { live: boolean },
): void => {
  // Only when there is a skill: attaching declares the resources capability,
  // and a server with nothing to serve keeps its surface unchanged. A skill
  // added later reaches the next session.
  if (service.current().skills.size > 0) service.skills.attach(server);
  // The SDK installs the prompt handlers, and declares the capability, on the
  // first registration, which it refuses once connected: one registered and
  // removed now lets a later edit add the first prompt of a live session.
  server.registerPrompt('customizations-placeholder', {}, () => userMessage('')).remove();
  let removers = registerPrompts(server, service.current());
  if (!live) return;
  const unsubscribe = service.onChange(() => {
    for (const remove of removers) remove();
    removers = registerPrompts(server, service.current());
  });
  const previous = server.server.onclose;
  server.server.onclose = () => {
    unsubscribe();
    previous?.();
  };
};
