import { type LintRuleKey, lintServer, parseToolDefinitions, type ToolDefinition } from 'mcp-tdqs';

// Reads a `tools/list` result the way any MCP client does, and nothing of this
// repository: no import outside `mcp-tdqs`, so the module can be lifted into a
// package of its own (pinned by `isolation.test.ts`). Why lint without the
// model-scored rubric: docs/decisions/tool-definition-quality.md.

export interface ToolDefinitionProblem {
  readonly check: string;
  readonly tool: string;
  readonly message: string;
}

export interface ToolDefinitionSignals {
  readonly name: string;
  readonly inputHash: string;
  readonly definitionBytes: number;
  readonly namesASibling: boolean;
}

export interface ShadowCandidateSignal {
  readonly tool: string;
  readonly cheaperSibling: string;
}

export interface ToolDefinitionReport {
  /** Blocking: each one is a definition an agent reads worse than it should. */
  readonly problems: readonly ToolDefinitionProblem[];
  /** Non-blocking: leads for a reviewer, never a verdict. */
  readonly shadowCandidates: readonly ShadowCandidateSignal[];
  readonly tools: readonly ToolDefinitionSignals[];
}

/**
 * The lint rules that never fail the gate, and why. Everything else `mcp-tdqs`
 * reports does.
 */
export const NON_GATING_LINT_RULES: Readonly<Partial<Record<LintRuleKey, string>>> = {
  'shadow-candidate':
    'a prefilter by invocation cost that only the coherence evaluation can confirm; reported as a lead',
  'no-output-schema':
    'tools return text shaped for the agent, and an output schema obliges a conforming structuredContent',
};

interface JsonSchemaNode {
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly items?: JsonSchemaNode;
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly allOf?: readonly JsonSchemaNode[];
}

const schemaOf = (tool: ToolDefinition): JsonSchemaNode | undefined =>
  (tool.inputSchema ?? undefined) as JsonSchemaNode | undefined;

/** Every property, at any depth, whose schema carries no description. */
export const undescribedProperties = (node: JsonSchemaNode | undefined, path = ''): string[] => {
  if (node === undefined) return [];
  const own = Object.entries(node.properties ?? {}).flatMap(([key, child]) => {
    const at = path ? `${path}.${key}` : key;
    return [...(child.description?.trim() ? [] : [at]), ...undescribedProperties(child, at)];
  });
  const nested = [
    ...(node.items ? undescribedProperties(node.items, `${path}[]`) : []),
    ...[...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])].flatMap((branch) =>
      undescribedProperties(branch, path),
    ),
  ];
  return [...own, ...nested];
};

const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

const allPropertyNames = (node: JsonSchemaNode | undefined): string[] =>
  node === undefined
    ? []
    : [
        ...Object.keys(node.properties ?? {}),
        ...Object.values(node.properties ?? {}).flatMap(allPropertyNames),
        ...allPropertyNames(node.items),
        ...[...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])].flatMap(
          allPropertyNames,
        ),
      ];

/**
 * Whether a description names another tool of the set. A one-word name
 * (`search`) only counts in backticks: bare, it is an ordinary English word.
 */
export const namesASibling = (tool: ToolDefinition, names: readonly string[]): boolean =>
  names.some(
    (name) =>
      name !== tool.name &&
      (name.includes('_')
        ? new RegExp(`\\b${name}\\b`).test(tool.description ?? '')
        : (tool.description ?? '').includes(`\`${name}\``)),
  );

/**
 * snake_case words shaped like a tool of this set (they start with one of its
 * verbs) that name none of its tools nor any parameter: a rename or removal the
 * prose did not follow.
 */
export const unknownToolReferences = (
  tool: ToolDefinition,
  tools: readonly ToolDefinition[],
): string[] => {
  const names = new Set(tools.map(({ name }) => name));
  const verbs = new Set(tools.map(({ name }) => name.split('_')[0]));
  const parameters = new Set(tools.flatMap((each) => allPropertyNames(schemaOf(each))));
  const words = new Set(tool.description?.match(SNAKE_CASE) ?? []);
  return [...words].filter(
    (word) => verbs.has(word.split('_')[0]) && !names.has(word) && !parameters.has(word),
  );
};

export const reviewToolDefinitions = (
  serverName: string,
  listed: unknown,
): ToolDefinitionReport => {
  const { tools } = parseToolDefinitions(listed);
  const lint = lintServer({ serverName, tools });
  const names = tools.map(({ name }) => name);

  const lintProblems = lint.findings
    .filter(({ rule }) => !(rule in NON_GATING_LINT_RULES))
    .map(({ rule, tool, message }) => ({
      check: `tdqs/${rule}`,
      tool: tool ?? '(server)',
      message,
    }));

  const ownProblems = tools.flatMap((tool) => [
    ...undescribedProperties(schemaOf(tool)).map((path) => ({
      check: 'undescribed-property',
      tool: tool.name,
      message: `${tool.name}: \`${path}\` has no description. A nested field is still a parameter the agent has to fill in.`,
    })),
    ...(tool.annotations?.['readOnlyHint'] === true && tool.annotations['destructiveHint'] === true
      ? [
          {
            check: 'annotation-conflict',
            tool: tool.name,
            message: `${tool.name}: readOnlyHint and destructiveHint are both true. A read-only tool cannot destroy anything; one of the two is wrong.`,
          },
        ]
      : []),
    ...unknownToolReferences(tool, tools).map((word) => ({
      check: 'unknown-tool-reference',
      tool: tool.name,
      message: `${tool.name}: the description mentions \`${word}\`, which is no tool of this server. Point at the tool that exists, or reword.`,
    })),
  ]);

  return {
    problems: [...lintProblems, ...ownProblems],
    shadowCandidates: lint.shadowCandidates.map(({ tool, cheaperSibling }) => ({
      tool,
      cheaperSibling,
    })),
    // lintServer keeps the order of the tools it is given.
    tools: lint.tools.map(({ name, contextSignals }, index) => ({
      name,
      inputHash: contextSignals.inputHash,
      definitionBytes: contextSignals.definitionBytes,
      namesASibling: tools[index] !== undefined && namesASibling(tools[index], names),
    })),
  };
};
