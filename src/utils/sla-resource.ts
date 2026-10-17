import type { NamedScope } from './sla-scope';

/**
 * The SLA alert resources. Fixed scheme: unlike the Help Center resources,
 * nothing about them depends on a deployment.
 */
export const SLA_RESOURCE_SCHEME = 'zendesk-sla';

export const SLA_ALERTS_TEMPLATES = {
  named: `${SLA_RESOURCE_SCHEME}://alerts/{scope}`,
  view: `${SLA_RESOURCE_SCHEME}://alerts/views/{view}`,
  query: `${SLA_RESOURCE_SCHEME}://alerts{?query}`,
} as const;

export const NAMED_SCOPES: readonly NamedScope[] = ['mine', 'my_groups', 'all'];

export const namedAlertsUri = (scope: NamedScope): string =>
  `${SLA_RESOURCE_SCHEME}://alerts/${scope}`;

/** What an alert resource URI asks for; a view stays a title or id until resolved. */
export type AlertsTarget =
  | { kind: 'scope'; scope: NamedScope }
  | { kind: 'view'; view: string | number }
  | { kind: 'query'; query: string };

const DIGITS = /^\d+$/;
const VIEW_PATH = /^\/views\/([^/]+)$/;

/** Reads an alert resource URI, or `undefined` when it names no alert set. */
export const parseAlertsUri = (raw: string): AlertsTarget | undefined => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${SLA_RESOURCE_SCHEME}:` || url.host !== 'alerts') return undefined;
  const path = url.pathname;
  if (path === '' || path === '/') {
    const query = url.searchParams.get('query')?.trim();
    return query ? { kind: 'query', query } : undefined;
  }
  const named = NAMED_SCOPES.find((scope) => path === `/${scope}`);
  if (named) return { kind: 'scope', scope: named };
  const view = VIEW_PATH.exec(path)?.[1];
  if (!view) return undefined;
  const decoded = decodeURIComponent(view);
  return { kind: 'view', view: DIGITS.test(decoded) ? Number(decoded) : decoded };
};
