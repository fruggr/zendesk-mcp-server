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
 * URI template of the pull-only Help Center article resources, built from the
 * configured scheme exactly like `topologyResourceUri` (`--hc-resource-scheme`,
 * default `zendesk-hc` → `zendesk-hc://article/{id}`). The template's `list`
 * callback enumerates the promoted ("featured") articles (so clients can surface
 * them for pinning), while any article id can be read on demand.
 */
export const articleResourceUriTemplate = (config: Config): string =>
  `${config.hcResourceScheme}://article/{id}`;

/**
 * Build the concrete resource URI for a single article id, under the configured
 * scheme. Shares the scheme with the template above so the listed URIs always
 * match the template the read callback is registered under.
 */
export const articleResourceUri = (config: Config, id: number): string =>
  `${config.hcResourceScheme}://article/${id}`;

/**
 * Whether the `help_center` namespace is active: no `--namespace` filter, or one
 * that includes it. The shared second half of the two Help Center feature gates
 * below, so the namespace semantics live in one place.
 */
const helpCenterNamespaceActive = (config: Config): boolean =>
  !config.namespaces?.length || config.namespaces.includes('help_center');

/**
 * Whether the Help Center structural context (init instructions + the
 * topology resource, default `zendesk-hc://topology`) should be exposed. True only when the
 * feature is enabled (`--no-topology` not set) AND the `help_center` namespace
 * is active. Shared by the instructions builder and the resource registration in
 * `server.ts` so both gates stay in sync.
 */
export const helpCenterContextEnabled = (config: Config): boolean =>
  config.topology && helpCenterNamespaceActive(config);

/**
 * Whether the read-by-id article resource (`<scheme>://article/{id}`) should be
 * registered. Available whenever the `help_center` namespace is active — reading
 * one article is a cheap, on-demand single fetch with NO preloading, so it is
 * deliberately NOT gated by the promoted-listing flag: `--no-promoted-articles`
 * turns off the costly pre-listing (below), never the ability to address a known
 * article id. Not tied to `--no-topology` either (topology is a separate feature).
 */
export const articleResourceEnabled = (config: Config): boolean =>
  helpCenterNamespaceActive(config);

/**
 * Whether the promoted-article PRE-LISTING is exposed: the resource `list`
 * callback's scan (which enumerates the promoted articles for `resources/list`)
 * AND the `list_promoted_articles` tool. This is the costly, fan-out part (a capped
 * scan of `/articles`, no server-side promoted filter), so it gets its own flag —
 * `--no-promoted-articles` turns it off so the server issues zero preloading
 * requests, while read-by-id (above) stays available. `!== false` (not truthiness)
 * so an omitted flag on a hand-built Config stays default-on, matching the tool
 * filter in `server.ts`.
 */
export const promotedArticlesEnabled = (config: Config): boolean =>
  config.promotedArticles !== false && helpCenterNamespaceActive(config);

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
