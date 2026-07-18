import type { Config } from '../config';

/** Stable URI of the dynamic Help Center topology resource. */
export const TOPOLOGY_RESOURCE_URI = 'zendesk-hc://topology';

/**
 * URI prefix of the pull-only Help Center article resources. Single source of
 * truth for both the `{id}` template registered on the server and the concrete
 * per-article URIs the list callback emits, so the two can never drift apart
 * (notably if the `zendesk-hc://` scheme is ever made configurable, see #169).
 */
export const ARTICLE_RESOURCE_URI_PREFIX = 'zendesk-hc://article/';

/**
 * URI template of the pull-only Help Center article resources. The template's
 * `list` callback enumerates the promoted ("featured") articles (so clients can
 * surface them for pinning), while any article id can be read on demand.
 */
export const ARTICLE_RESOURCE_URI_TEMPLATE = `${ARTICLE_RESOURCE_URI_PREFIX}{id}`;

/** Build the concrete resource URI for a single article id. */
export const articleResourceUri = (id: number): string => `${ARTICLE_RESOURCE_URI_PREFIX}${id}`;

/**
 * Whether the `help_center` namespace is active: no `--namespace` filter, or one
 * that includes it. The shared second half of the two Help Center feature gates
 * below, so the namespace semantics live in one place.
 */
const helpCenterNamespaceActive = (config: Config): boolean =>
  !config.namespaces?.length || config.namespaces.includes('help_center');

/**
 * Whether the Help Center structural context (init instructions + the
 * `zendesk-hc://topology` resource) should be exposed. True only when the
 * feature is enabled (`--no-topology` not set) AND the `help_center` namespace
 * is active. Shared by the instructions builder and the resource registration in
 * `server.ts` so both gates stay in sync.
 */
export const helpCenterContextEnabled = (config: Config): boolean =>
  config.topology && helpCenterNamespaceActive(config);

/**
 * Whether the pull-only Help Center article resources
 * (`zendesk-hc://article/{id}`) should be exposed. True only when the feature is
 * enabled (`--no-article-resources` not set) AND the `help_center` namespace is
 * active. Same double-gate as `helpCenterContextEnabled`, but keyed to its own
 * flag so an operator can toggle the topology resource and the article resources
 * independently.
 */
export const articleResourcesEnabled = (config: Config): boolean =>
  config.articleResources && helpCenterNamespaceActive(config);

/**
 * The static `instructions` blob sent on `initialize`. Deliberately short and
 * I/O-free: it must not trigger the lazy OAuth/PKCE flow just to connect, and
 * it stays within a tight token budget. The rich, dynamic topology lives in the
 * pull-only `zendesk-hc://topology` resource referenced here.
 */
export const buildInstructions = (config: Config): string | undefined => {
  if (!helpCenterContextEnabled(config)) return undefined;
  return [
    `This MCP server is connected to the Zendesk Help Center of "${config.subdomain}".`,
    '',
    `When creating or editing Help Center content, the resource ${TOPOLOGY_RESOURCE_URI} is useful context:`,
    'it lists the active locales (and the default one), the category → section tree with IDs,',
    'the visibility user segments, the permission groups, and your current role.',
    'Prefer its IDs (section_id, permission_group_id, user_segment_id, locale) over guessing from names.',
    '',
    'It degrades gracefully: without Guide-admin / Help Center manager rights the permission-groups and',
    'user-segments sections are marked unavailable (not empty). In that case reuse a permission_group_id',
    'or user_segment_id from an existing article (get_article) instead.',
  ].join('\n');
};
