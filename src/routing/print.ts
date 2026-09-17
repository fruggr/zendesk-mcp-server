import type { Config } from '../config';
import type { ToolDefinition } from '../tools/definitions';
import { filterTools, groupByNamespace, NAMESPACE_LABELS } from './registry';

const toolLine = (tool: ToolDefinition, indent: string): string =>
  `${indent}${tool.name}${tool.readOnly ? '' : ' (write)'}`;

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

const renderNamespaceMode = (tools: ToolDefinition[]): string[] => {
  const grouped = groupByNamespace(tools);
  const lines = [`${grouped.size} proxy tool(s) exposed:`];
  for (const [namespace, nsTools] of grouped) {
    // Stryker disable next-line OptionalChaining: NAMESPACE_LABELS is typed
    // Record<Namespace, ...>, so this lookup cannot miss -- an incomplete map is a
    // compile error. The `?.` exists only to satisfy noUncheckedIndexedAccess,
    // which makes the fallback unreachable and untestable.
    lines.push(`  ${NAMESPACE_LABELS[namespace]?.toolName ?? namespace}`);
    lines.push(...nsTools.map((tool) => toolLine(tool, '    - ')));
  }
  return lines;
};

const renderSingleMode = (tools: ToolDefinition[]): string[] => [
  `1 proxy tool exposed, wrapping ${tools.length} operation(s):`,
  '  zendesk',
  ...tools.map((tool) => toolLine(tool, '    - ')),
];

const renderBody = (config: Config, tools: ToolDefinition[]): string[] => {
  switch (config.mode) {
    case 'all':
      return renderAllMode(tools);
    case 'namespace':
      return renderNamespaceMode(tools);
    case 'single':
      return renderSingleMode(tools);
    default: {
      // Closed union; the guard is for a mode fed in by a hand-edited config.
      const unhandled: never = config.mode;
      throw new Error(`Unsupported tool mode: ${String(unhandled)}`);
    }
  }
};

/**
 * Render the tool surface `config` resolves to, as `registerToolset` would
 * expose it, without starting a server or issuing a request -- the combination
 * of `--namespace`/`--tool`, `--mode` and `--read-only` is easier read than
 * predicted.
 *
 * It mirrors `registerToolset`'s `switch (config.mode)` rather than calling it,
 * which would need a live `McpServer`; tests pin this output against the names
 * the integration harness sees over the wire.
 *
 * Read-only is stated in the header, not as a `[RO]` name prefix: the server
 * puts that marker in a proxy's description, so `[RO] zendesk_tickets` would
 * name a tool no client sees.
 */
export const renderToolSurface = (config: Config, tools: ToolDefinition[]): string => {
  // Same call `registerToolset` makes, flag for flag: the point of this output
  // is that it matches the running server, so it must not filter differently.
  const filtered = filterTools(tools, {
    readOnly: config.readOnly,
    namespaces: config.namespaces,
    tools: config.tools,
    promotedArticles: config.promotedArticles,
  });

  const header = renderHeader(config);
  if (filtered.length === 0) {
    return `${header}\n\nNo tools exposed. Check --namespace / --tool / --read-only.`;
  }
  return [header, '', ...renderBody(config, filtered)].join('\n');
};
