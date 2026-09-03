import type { Namespace } from '../config';
import { LIST_PROMOTED_ARTICLES_TOOL } from '../guidance/article-resources';
import type { ToolDefinition } from '../tools/definitions';

export interface FilterOptions {
  readOnly: boolean;
  namespaces?: Namespace[] | undefined;
  tools?: string[] | undefined;
  /**
   * Mirrors `config.promotedArticles`. When explicitly false
   * (`--no-promoted-articles`), `list_promoted_articles` is dropped: that
   * listing must make ZERO Zendesk calls, and gating only the resource `list`
   * callback would leave the tool callable and still scanning. `!== false` so a
   * hand-built config without the field keeps the default-on behaviour.
   */
  promotedArticles?: boolean | undefined;
}

/**
 * The single authority on which tools a config exposes.
 *
 * Every filter lives here rather than at the call sites, because there is more
 * than one consumer -- `registerToolset` registers them and `renderToolSurface`
 * prints them -- and a filter applied in only one of the two makes
 * `--print-tools` lie about the running server.
 */
export const filterTools = (allTools: ToolDefinition[], options: FilterOptions): ToolDefinition[] =>
  allTools.filter((tool) => {
    if (options.readOnly && !tool.readOnly) return false;
    if (options.namespaces?.length && !options.namespaces.includes(tool.namespace)) return false;
    if (options.tools?.length && !options.tools.includes(tool.name)) return false;
    if (options.promotedArticles === false && tool.name === LIST_PROMOTED_ARTICLES_TOOL) {
      return false;
    }
    return true;
  });

export const groupByNamespace = (tools: ToolDefinition[]): Map<Namespace, ToolDefinition[]> => {
  const grouped = new Map<Namespace, ToolDefinition[]>();
  for (const tool of tools) {
    const existing = grouped.get(tool.namespace) ?? [];
    existing.push(tool);
    grouped.set(tool.namespace, existing);
  }
  return grouped;
};

/**
 * Proxy tool name and title per namespace, used by `namespace` mode.
 *
 * Typed `Record<Namespace, …>` rather than `Record<string, …>` so the compiler
 * rejects this literal outright when a namespace is added to the enum without
 * a label here. That matters because the consumer looks the label up and skips
 * the namespace when it is missing: an incomplete map would silently expose no
 * proxy for a whole namespace, with every existing test still green. Making it
 * a type error is stronger than any test could be.
 */
export const NAMESPACE_LABELS: Record<Namespace, { toolName: string; title: string }> = {
  tickets: { toolName: 'zendesk_tickets', title: 'Zendesk Tickets' },
  help_center: { toolName: 'zendesk_help_center', title: 'Zendesk Help Center' },
  users: { toolName: 'zendesk_users', title: 'Zendesk Users' },
  requests: { toolName: 'zendesk_requests', title: 'Zendesk Requests' },
};
