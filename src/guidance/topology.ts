import { helpCenterGet, ZendeskApiError, zendeskGet } from '../client/zendesk-api';
import { MAX_PAGE_SIZE, TOPOLOGY_TTL_MS } from '../constants';
import type {
  ZendeskCategory,
  ZendeskListResponse,
  ZendeskLocalesResponse,
  ZendeskPermissionGroup,
  ZendeskSection,
  ZendeskUser,
  ZendeskUserSegment,
} from '../types';
import {
  formatCategory,
  formatPermissionGroup,
  formatSection,
  formatUserSegment,
  truncateIfNeeded,
} from '../utils/formatting';
import { extractPaginationMeta } from '../utils/pagination';

/** Aggregated, auto-discoverable structure of a Help Center instance. */
export interface TopologyData {
  subdomain: string;
  locales: ZendeskLocalesResponse;
  categories: ZendeskCategory[];
  sections: ZendeskSection[];
  /** True when the tenant has more sections than a single page (tree omitted). */
  sectionsHasMore: boolean;
  /** True when the tenant has more categories than a single page (tree omitted). */
  categoriesHasMore: boolean;
  userSegments: ZendeskUserSegment[];
  permissionGroups: ZendeskPermissionGroup[];
  currentUser: ZendeskUser;
}

/**
 * Fetch the structural topology with the CALLER'S token, so the result respects
 * that user's read permissions (no privileged shared credential). Categories
 * and sections are each capped at one max-size page; `sectionsHasMore` /
 * `categoriesHasMore` signal a Help Center too large to enumerate inline.
 */
export const fetchTopology = async (subdomain: string, token: string): Promise<TopologyData> => {
  const pageParams = { 'page[size]': String(MAX_PAGE_SIZE) };
  const [locales, categoriesRes, sectionsRes, segmentsRes, permsRes, meRes] = await Promise.all([
    helpCenterGet<ZendeskLocalesResponse>(subdomain, token, '/locales'),
    helpCenterGet<ZendeskListResponse<ZendeskCategory>>(
      subdomain,
      token,
      '/categories',
      pageParams,
    ),
    helpCenterGet<ZendeskListResponse<ZendeskSection>>(subdomain, token, '/sections', pageParams),
    helpCenterGet<{ user_segments: ZendeskUserSegment[] }>(subdomain, token, '/user_segments'),
    zendeskGet<{ permission_groups: ZendeskPermissionGroup[] }>(
      subdomain,
      token,
      '/guide/permission_groups',
    ),
    zendeskGet<{ user: ZendeskUser }>(subdomain, token, '/users/me'),
  ]);

  const categories = categoriesRes.categories ?? [];
  const sections = sectionsRes.sections ?? [];
  return {
    subdomain,
    locales,
    categories,
    sections,
    sectionsHasMore: extractPaginationMeta(sectionsRes, sections.length).has_more,
    categoriesHasMore: extractPaginationMeta(categoriesRes, categories.length).has_more,
    userSegments: segmentsRes.user_segments ?? [],
    permissionGroups: permsRes.permission_groups ?? [],
    currentUser: meRes.user,
  };
};

const renderTree = (data: TopologyData): string[] => {
  // Too many categories or sections to enumerate honestly from one page: omit the
  // tree and point at the list_* tools rather than showing a misleading partial
  // tree. When categories overflow, the category list below is itself partial.
  if (data.categoriesHasMore || data.sectionsHasMore) {
    const reasons: string[] = [];
    if (data.categoriesHasMore) reasons.push(`more than ${MAX_PAGE_SIZE} categories`);
    if (data.sectionsHasMore) reasons.push(`more than ${MAX_PAGE_SIZE} sections`);
    return [
      `Large Help Center (${reasons.join(' and ')}) — the full tree is omitted to stay concise.`,
      data.categoriesHasMore ? 'Categories (partial list):' : 'Categories:',
      ...data.categories.map(formatCategory),
      '',
      ...(data.categoriesHasMore
        ? ['Use the `list_categories` tool to enumerate all categories.']
        : []),
      'Use the `list_sections` tool (filtered by `category_id`) to enumerate sections under a category.',
    ];
  }

  const byCategory = new Map<number, ZendeskSection[]>();
  for (const section of data.sections) {
    const list = byCategory.get(section.category_id) ?? [];
    list.push(section);
    byCategory.set(section.category_id, list);
  }

  const lines: string[] = [];
  for (const category of data.categories) {
    lines.push(formatCategory(category));
    for (const section of byCategory.get(category.id) ?? []) {
      lines.push(`  ${formatSection(section)}`);
    }
  }
  return lines.length ? lines : ['_(no categories)_'];
};

/** Render the topology as a compact Markdown document for the LLM context. */
export const formatTopology = (data: TopologyData): string => {
  const text = [
    `# Zendesk Help Center topology — ${data.subdomain}`,
    '',
    `**Your access**: ${data.currentUser.name} (id ${data.currentUser.id}), role "${data.currentUser.role}".`,
    '',
    '## Locales',
    `- Default: ${data.locales.default_locale}`,
    `- Active: ${data.locales.locales.join(', ')}`,
    '',
    '## Categories → sections',
    ...renderTree(data),
    '',
    '## Visibility (user segments)',
    ...(data.userSegments.length ? data.userSegments.map(formatUserSegment) : ['_(none)_']),
    '',
    '## Permission groups',
    ...(data.permissionGroups.length
      ? data.permissionGroups.map(formatPermissionGroup)
      : ['_(none)_']),
  ].join('\n');

  return truncateIfNeeded(text);
};

export interface TopologyProvider {
  read(): Promise<string>;
}

/**
 * Build a topology provider holding a memoized-promise cache (TTL
 * `TOPOLOGY_TTL_MS`). In HTTP mode `createMcpServer` — and therefore this
 * provider — is instantiated PER SESSION, so this cache is per-session /
 * per-caller: it must NOT be hoisted to module scope, or one tenant's structure
 * would leak to another. The promise (not the value) is cached to coalesce
 * concurrent reads; failures are evicted so the next read retries with a fresh
 * token. A 401 notifies `onUnauthorized` (stdio OAuth only) to invalidate the
 * stale token, mirroring the tool dispatch path in `server.ts`.
 */
export const createTopologyProvider = (
  getToken: () => string | Promise<string>,
  subdomain: string,
  onUnauthorized?: () => void,
): TopologyProvider => {
  let cached: { at: number; promise: Promise<string> } | undefined;

  return {
    read() {
      const now = Date.now();
      if (cached && now - cached.at < TOPOLOGY_TTL_MS) return cached.promise;

      const promise = (async () => {
        const token = await getToken();
        return formatTopology(await fetchTopology(subdomain, token));
      })().catch((err: unknown) => {
        cached = undefined;
        if (onUnauthorized && err instanceof ZendeskApiError && err.status === 401) {
          onUnauthorized();
        }
        throw err;
      });

      cached = { at: now, promise };
      return promise;
    },
  };
};
