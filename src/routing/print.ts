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
 *
 * Every name printed is a name a client would actually see. Read-only mode is
 * stated in the header rather than as a `[RO]` prefix on the names: the server
 * puts that marker in a proxy's *description*, never in its name, and printing
 * `[RO] zendesk_tickets` here would name a tool that does not exist.
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
