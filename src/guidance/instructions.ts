import type { Config } from '../config';

/** Stable URI of the dynamic Help Center topology resource. */
export const TOPOLOGY_RESOURCE_URI = 'zendesk-hc://topology';

/**
 * Whether the Help Center structural context (init instructions + the
 * `zendesk-hc://topology` resource) should be exposed. True only when the
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
 * pull-only `zendesk-hc://topology` resource referenced here.
 */
export const buildInstructions = (config: Config): string | undefined => {
  if (!helpCenterContextEnabled(config)) return undefined;
  return [
    `This MCP server is connected to the Zendesk Help Center of "${config.subdomain}".`,
    '',
    `Before creating or editing Help Center content, read the resource ${TOPOLOGY_RESOURCE_URI}.`,
    'It describes the active locales (and the default one), the category → section tree with IDs,',
    'the visibility user segments, the permission groups, and your current role.',
    'Prefer the IDs from that resource (section_id, permission_group_id, user_segment_id, locale)',
    'over guessing from names.',
  ].join('\n');
};
