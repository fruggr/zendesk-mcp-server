import type { Config } from '../config';
import type { ToolDefinition } from '../tools/definitions';
import { filterTools, groupByNamespace, NAMESPACE_LABELS } from './registry';

/** `name (write)` for a write tool, bare `name` for a read one. */
const toolLine = (tool: ToolDefinition, indent: string): string =>
  `${indent}${tool.name}${tool.readOnly ? '' : ' (write)'}`;

/** The knobs in force, on one line, so the listing below is self-explaining. */
const renderHeader = (config: Config): string =>
  [
    `Mode: ${config.mode}`,
    `Namespaces: ${config.namespaces.join(', ')}`,
    `Read-only: ${config.readOnly ? 'yes' : 'no'}`,
    ...(config.tools?.length ? [`Tool filter: ${config.tools.join(', ')}`] : []),
  ].join(' | ');

const renderAllMode = (tools: ToolDefinition[]): string[] => [
  `${tools.length} tool(s) exposed individually:`,
  ...tools.map((tool) => toolLine(tool, '  ')),
];

// `prefix` carries the `[RO]` marker the proxy descriptions themselves use in
// read-only mode, so the listing matches what a client that ignores annotations
// actually reads.
const renderNamespaceMode = (tools: ToolDefinition[], prefix: string): string[] => {
  const grouped = groupByNamespace(tools);
  const lines = [`${grouped.size} proxy tool(s) exposed:`];
  for (const [namespace, nsTools] of grouped) {
    // Stryker disable next-line OptionalChaining: NAMESPACE_LABELS is typed
    // Record<Namespace, ...>, so this lookup cannot miss -- an incomplete map is a
    // compile error. The `?.` exists only to satisfy noUncheckedIndexedAccess,
    // which makes the fallback unreachable and untestable.
    lines.push(`  ${prefix}${NAMESPACE_LABELS[namespace]?.toolName ?? namespace}`);
    lines.push(...nsTools.map((tool) => toolLine(tool, '    - ')));
  }
  return lines;
};

const renderSingleMode = (tools: ToolDefinition[], prefix: string): string[] => [
  `1 proxy tool exposed, wrapping ${tools.length} operation(s):`,
  `  ${prefix}zendesk`,
  ...tools.map((tool) => toolLine(tool, '    - ')),
];

const renderBody = (config: Config, tools: ToolDefinition[]): string[] => {
  const prefix = config.readOnly ? '[RO] ' : '';
  switch (config.mode) {
    case 'all':
      return renderAllMode(tools);
    case 'namespace':
      return renderNamespaceMode(tools, prefix);
    case 'single':
      return renderSingleMode(tools, prefix);
    default: {
      // Closed union; the guard is for a mode fed in by a hand-edited config.
      const unhandled: never = config.mode;
      throw new Error(`Unsupported tool mode: ${String(unhandled)}`);
    }
  }
};

/**
 * Render the tool surface `config` resolves to, as `registerToolset` would
 * expose it, without starting a server or issuing a single request.
 *
 * The surface is shaped by three independent knobs — `--namespace` / `--tool`
 * pick the inventory, `--mode` packages it, `--read-only` narrows it — and their
 * combination is far easier to read off a listing than to predict. This is what
 * `--print-tools` prints.
 *
 * It mirrors the `switch (config.mode)` in `registerToolset` rather than
 * calling it: registration needs a live `McpServer`, and building one here
 * would drag in a transport. The duplication is three branches wide and is
 * pinned by tests asserting this output against the names the integration
 * harness sees over the wire.
 */
export const renderToolSurface = (config: Config, tools: ToolDefinition[]): string => {
  const filtered = filterTools(tools, {
    readOnly: config.readOnly,
    namespaces: config.namespaces,
    tools: config.tools,
  });

  const header = renderHeader(config);
  if (filtered.length === 0) {
    return `${header}\n\nNo tools exposed. Check --namespace / --tool / --read-only.`;
  }
  return [header, '', ...renderBody(config, filtered)].join('\n');
};
