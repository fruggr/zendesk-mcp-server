import type { ToolDefinition } from '../tools/definitions';

/**
 * What a proxy (`namespace` / `single` mode) tells the model about the
 * operations it wraps. The tool description stays under the client cap and
 * only names the operations; the per-operation detail (signature, summary,
 * write marker) lives in the `operation` property description, which clients
 * pass whole. Measurements, limits and how to re-verify them:
 * docs/decisions/proxy-schema-surface.md.
 */

type ProxyOperation = Pick<ToolDefinition, 'name' | 'description' | 'readOnly' | 'inputSchema'>;

// Claude Code cuts any MCP tool description past this length (`… [truncated]`).
export const MAX_TOOL_DESCRIPTION_LENGTH = 2048;

// The longest property description verified to reach the model whole (Claude
// Code 2.1.287). Raise it only after re-running scripts/probe-mcp-description-cap.mjs.
export const VERIFIED_SCHEMA_DESCRIPTION_LENGTH = 15_000;

export const PARAMS_FIELD_DESCRIPTION =
  'Parameters of the chosen operation, named exactly as its line in "operation" lists them (* = required). An unknown name is rejected.';

export const summarizeDescription = (description: string): string => {
  const idx = description.indexOf('. ');
  if (idx === -1) return description;
  return description.slice(0, idx + 1);
};

// Required = the field rejects `undefined`, which is what the strict params
// parser enforces; `.optional()` and `.default()` fields are both omittable.
export const operationSignature = (tool: Pick<ProxyOperation, 'name' | 'inputSchema'>): string => {
  const params = Object.entries(tool.inputSchema.shape).map(([key, field]) =>
    field.safeParse(undefined).success ? key : `${key}*`,
  );
  return `${tool.name}(${params.join(', ')})`;
};

export const buildOperationList = (tools: readonly ProxyOperation[]): string =>
  tools
    .map(
      (t) =>
        `- ${operationSignature(t)}: ${summarizeDescription(t.description)}${t.readOnly ? '' : ' (write)'}`,
    )
    .join('\n');

export const buildOperationFieldDescription = (tools: readonly ProxyOperation[]): string =>
  `One of the operations below. Each line reads name(parameters): summary, where the parameters are the exact names "params" accepts and * marks a required one; (write) marks an operation that changes data.\n${buildOperationList(tools)}`;

export const buildProxyDescription = ({
  title,
  tools,
  readOnly,
}: {
  title: string;
  tools: readonly Pick<ProxyOperation, 'name'>[];
  readOnly: boolean;
}): string => {
  // `[RO]` leads for clients that never show annotations to the model.
  const head = `${readOnly ? '[RO] ' : ''}${title}. Specify the operation and its parameters. The "operation" field lists every operation with a one-line summary and the parameter names "params" accepts (* = required); an unknown parameter is rejected with the list of valid ones.`;
  const withNames = `${head}\n\nOperations: ${tools.map((t) => t.name).join(', ')}`;
  // Past the cap the name list goes, not the guidance: the `operation` field
  // still carries every name, and a cut description could end mid-sentence.
  return withNames.length <= MAX_TOOL_DESCRIPTION_LENGTH ? withNames : head;
};
