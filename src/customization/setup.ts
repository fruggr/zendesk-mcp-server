/**
 * The `setup` guide served on `/mcp/admin`, as a prompt and as a skill. Its
 * main use is the first configuration; the same steps serve a later revision.
 */
export const SETUP_NAME = 'setup';

export const SETUP_DESCRIPTION =
  "Set up or revise what this Zendesk MCP server teaches every user's assistant: team instructions, prompts and skills. Use when a Zendesk admin wants to configure, review or change them.";

export const SETUP_BODY = `# Set up the assistant for your team

You are helping a Zendesk administrator configure what this MCP server distributes to every user's AI assistant, with the manage_customizations tool.

## 1. Start from what already exists

Before proposing anything:

1. Call manage_customizations with action "list". It shows the built-in context the server already sends on its own, and the customizations already configured.
2. Read the built-in context: action "get", kind "built_in", name "instructions" (what every session already receives), then name "topology" (the Help Center structure: locales, categories and sections with ids, segments, permission groups).
3. Summarize both for the admin in a few lines, then ask what they want their team's assistants to do differently.

## 2. Pick the right kind for each need

- Instructions: short, always-on rules every session receives (tone, vocabulary, what never to do). Every session pays for them in context, so keep them to a few lines per scope. Scope "global" reaches every session; a namespace scope (tickets, help_center, users, requests, preferences) reaches only the sessions that expose it.
- Prompt: a workflow a user starts on purpose from their client's prompt menu (draft a reply in our style, triage a ticket). It costs nothing until used.
- Skill: reference material or a procedure the assistant loads by itself when a task matches its description (style guide, lexicon, translation workflow). Write that description so it says when to use the skill.

Ask the admin about their team's practices. Never invent rules on their behalf.

## 3. Never duplicate what is built in

Before each set, compare the text with the built-in context you read in step 1. The server already tells every assistant which Help Center it is connected to, its locales, its category and section tree with ids, its segments and permission groups, the user's role, and the SLA alert thresholds. If the admin asks to add any of these (the Help Center URL, the languages, the list of sections...), tell them it is already provided, say where it comes from, and do not write it.

Also compare new content with the existing customizations, so that two entries never repeat or contradict each other.

## 4. Mind the clients that do not support skills

Many MCP clients do not support MCP skills yet. For them the server also serves every skill as a prompt of the same name, but the conversion is lossy: the prompt carries SKILL.md only, truncated when long; the skill's other files are listed but not included, and scripts cannot run. So:

- put everything essential in SKILL.md itself;
- avoid skills that depend on running code;
- warn the admin when a skill they want relies on extra files or code.

## 5. Write, then check

- Show the admin the exact text before each set, and write it only once they agree.
- After setting instructions, the tool returns everything a new session receives. Re-read it for repetitions and contradictions with the built-in part.
- Instructions reach new sessions only. Prompts and skills reach open sessions on clients that refresh their lists.
- Names use lowercase letters, digits and hyphens. A skill's SKILL.md starts with a frontmatter block holding its name and a one-line description.
`;

export const SETUP_SKILL = `---
name: ${SETUP_NAME}
description: ${JSON.stringify(SETUP_DESCRIPTION)}
---

${SETUP_BODY}`;
