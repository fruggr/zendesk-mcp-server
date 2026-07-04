import { describe, it } from 'vitest';
import { createAllTools, type ToolContext } from '../../../src/tools';

// Deterministic "tool definition quality" gate — the machine-checkable floor of
// the Glama Tool Definition Quality rubric (docs/mcp-metadata.md). It does NOT
// judge whether prose is *good* (that is CodeRabbit's job, see .coderabbit.yaml);
// it guarantees no tool ships grossly under-documented. This matters because the
// server score is `60% mean + 40% MIN` across tools, so a single thin tool drags
// the whole surface down — the MIN term is exactly what a floor protects.
//
// Failure messages are written to TEACH the fixer (LLM or human) the intent, not
// just to flag a red. They cite the offending text, the Glama dimension at stake,
// and an exemplar tool to imitate — deliberately WITHOUT naming the mechanical
// pass condition, so the fix is a real improvement rather than gaming the check.

const ctx: ToolContext = { subdomain: 'testsubdomain', getToken: () => 'test-token' };
const tools = createAllTools(ctx);

// Exemplars already in the tree that clear the bar — point fixers at these.
const DOC = 'docs/mcp-metadata.md';
const PARAM_EXEMPLAR =
  'manage_tags (tickets.ts) — every param says what it is, its format, and how to get it';
const DESC_EXEMPLAR =
  'update_ticket / list_sla_policies (tickets.ts) — capability, then behaviour, then when-to-use';
const EFFECT_EXEMPLAR =
  'update_ticket ("the updated ticket is returned") / create_content_tag ("returns the created tag with its id")';

// Words that carry no information beyond the field name itself.
const STOPWORDS = new Set([
  'to',
  'the',
  'a',
  'an',
  'of',
  'for',
  'on',
  'in',
  'by',
  'with',
  'and',
  'or',
  'id',
  'ids',
  'number',
  'string',
  'value',
  'optional',
]);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

// A describe is a "restatement" when, after removing stopwords and the field's
// own name words, fewer than 2 distinct informative tokens remain. Catches
// "Ticket ID", "Page number", "Results per page", "Tags to add"; passes
// "Locale for translated version".
const novelTokenCount = (name: string, description: string): number => {
  const nameWords = new Set(tokenize(name.replace(/_/g, ' ')));
  const novel = new Set(
    tokenize(description).filter((t) => !STOPWORDS.has(t) && !nameWords.has(t)),
  );
  return novel.size;
};

const shapeOf = (tool: (typeof tools)[number]): Record<string, { description?: string }> =>
  (tool.inputSchema as unknown as { shape: Record<string, { description?: string }> }).shape;

// A write tool must tell the caller what it changes / returns. Backstop list of
// effect verbs — intentionally NOT surfaced in the failure message.
const EFFECT =
  /\b(returns?|replaces?|creates?|updates?|deletes?|adds?|removes?|sets?|posts?|uploads?|no-op|idempotent|overwrites?|changes?)\b/i;

const countSentences = (text: string): number =>
  text
    .split(/[.!?](?:\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10).length;

const fail = (problems: string[]): void => {
  if (problems.length > 0) {
    throw new Error(
      `\nTool definition quality gate failed (${problems.length}):\n\n${problems.join('\n\n')}\n`,
    );
  }
};

describe('tool definition quality gate', () => {
  it('RULE A — every parameter description explains the param, not just its name', () => {
    const problems: string[] = [];
    for (const tool of tools) {
      for (const [name, field] of Object.entries(shapeOf(tool))) {
        const desc = field.description?.trim() ?? '';
        if (desc.length === 0) {
          problems.push(
            `❌ ${tool.name}.${name} — no .describe().\n` +
              `   Glama "Parameter Semantics" (15%): every param must explain meaning, format and\n` +
              `   constraints so a caller can use it without reading the source.\n` +
              `   Fix: describe what the param IS and its constraints, like ${PARAM_EXEMPLAR}. See ${DOC}.`,
          );
          continue;
        }
        if (novelTokenCount(name, desc) < 2) {
          problems.push(
            `❌ ${tool.name}.${name} — description "${desc}" merely restates the field name.\n` +
              `   Glama "Parameter Semantics" (15%). Server score is 60% mean + 40% MIN across tools,\n` +
              `   so one thin param drags the whole surface down — this is a floor, not an average.\n` +
              `   Fix: add real meaning/format/constraints, like ${PARAM_EXEMPLAR}.\n` +
              `   Do NOT just pad the string to look longer — the review rejects empty padding. See ${DOC}.`,
          );
        }
      }
    }
    fail(problems);
  });

  it('RULE B — every tool description is more than one sentence', () => {
    const problems: string[] = [];
    for (const tool of tools) {
      if (countSentences(tool.description) < 2) {
        problems.push(
          `❌ ${tool.name} — description is a single sentence: "${tool.description}"\n` +
            `   Glama "Contextual Completeness" (10%) & "Usage Guidelines" (20%): one sentence rarely\n` +
            `   states behaviour, side effects, or when to use vs. a sibling tool.\n` +
            `   Fix: add a second sentence on what it returns / affects and when to reach for it,\n` +
            `   like ${DESC_EXEMPLAR}. Keep the first sentence standalone (proxy modes surface only it). See ${DOC}.`,
        );
      }
    }
    fail(problems);
  });

  it('RULE C — every write tool states its effect or return value', () => {
    const problems: string[] = [];
    for (const tool of tools) {
      if (!tool.readOnly && !EFFECT.test(tool.description)) {
        problems.push(
          `❌ ${tool.name} — write tool (readOnly=false) whose description does not state what it\n` +
            `   changes or returns: "${tool.description}"\n` +
            `   Glama "Behavioral Transparency" (20%): a mutation's side effects must be explicit.\n` +
            `   Fix: say what is created/updated/removed and what comes back, like ${EFFECT_EXEMPLAR}. See ${DOC}.`,
        );
      }
    }
    fail(problems);
  });
});
