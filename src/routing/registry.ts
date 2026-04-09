import type { Namespace } from '../config';
import type { ToolDefinition } from '../tools/definitions';

export interface FilterOptions {
  readOnly: boolean;
  namespaces?: Namespace[] | undefined;
  tools?: string[] | undefined;
}

export const filterTools = (allTools: ToolDefinition[], options: FilterOptions): ToolDefinition[] =>
  allTools.filter((tool) => {
    if (options.readOnly && !tool.readOnly) return false;
    if (options.namespaces?.length && !options.namespaces.includes(tool.namespace)) return false;
    if (options.tools?.length && !options.tools.includes(tool.name)) return false;
    return true;
  });

export const groupByNamespace = (tools: ToolDefinition[]): Map<string, ToolDefinition[]> => {
  const grouped = new Map<string, ToolDefinition[]>();
  for (const tool of tools) {
    const existing = grouped.get(tool.namespace) ?? [];
    existing.push(tool);
    grouped.set(tool.namespace, existing);
  }
  return grouped;
};
