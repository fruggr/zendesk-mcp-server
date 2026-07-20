import type { Config } from '../config';

/**
 * URI of the dynamic Help Center topology resource. Single source of truth for
 * every place that cites it (resource registration, `instructions` blob): the
 * scheme comes from the config (`--hc-resource-scheme`, default `zendesk-hc`),
 * the path is fixed. Any future Help Center resource should build its URI the
 * same way so the whole surface follows the configured scheme.
 */
export const topologyResourceUri = (config: Config): string =>
  `${config.hcResourceScheme}://topology`;

/**
 * Whether the Help Center structural context (init instructions + the
 * topology resource, default `zendesk-hc://topology`) should be exposed. True only when the
 * feature is enabled (`--no-topology` not set) AND the `help_center` namespace
 * is active (no `--namespace` filter, or one that includes it). Shared by the
 * instructions builder and the resource registration in `server.ts` so both
 * gates stay in sync.
 */
export const helpCenterContextEnabled = (config: Config): boolean =>
  config.topology && (!config.namespaces?.length || config.namespaces.includes('help_center'));

/**
 * The static `instructions` blob sent on `initialize`. Deliberately short and
 * I/O-free: it must not trigger the lazy OAuth/PKCE flow just to connect, and
 * it stays within a tight token budget. The rich, dynamic topology lives in the
 * pull-only topology resource (default `zendesk-hc://topology`) referenced here.
 */
export const buildInstructions = (config: Config): string | undefined => {
  if (!helpCenterContextEnabled(config)) return undefined;
  return [
    `This MCP server is connected to the Zendesk Help Center of "${config.subdomain}".`,
    '',
    `When creating or editing Help Center content, the resource ${topologyResourceUri(config)} is useful context:`,
    'it lists the active locales (and the default one), the category → section tree with IDs,',
    'the visibility user segments, the permission groups, and your current role.',
    'Prefer its IDs (section_id, permission_group_id, user_segment_id, locale) over guessing from names.',
    '',
    'It degrades gracefully: without Guide-admin / Help Center manager rights the permission-groups and',
    'user-segments sections are marked unavailable (not empty). In that case reuse a permission_group_id',
    'or user_segment_id from an existing article (get_article) instead.',
  ].join('\n');
};
