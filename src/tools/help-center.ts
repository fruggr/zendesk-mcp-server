import * as z from 'zod/v4';
import { fetchAllBrands } from '../client/brands';
import {
  helpCenterDelete,
  helpCenterGet,
  helpCenterPost,
  helpCenterPut,
  helpCenterUpload,
  ZendeskApiError,
  zendeskGet,
  zendeskPost,
} from '../client/zendesk-api';
import {
  ARTICLE_RESOURCES_SCAN_MAX_PAGES,
  CONTENT_TAGS_MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  LARGE_ARTICLE_BODY_CHARS,
  LARGE_ARTICLE_SECTION_COUNT,
  MAX_BASE64_INPUT_CHARS,
  MAX_BASE64_INPUT_MB,
  MAX_PAGE_SIZE,
  REORDER_CONFIRM_THRESHOLD,
} from '../constants';
import { fetchPromotedArticles, LIST_PROMOTED_ARTICLES_TOOL } from '../guidance/article-resources';
import type {
  ZendeskArticle,
  ZendeskArticleAttachment,
  ZendeskCategory,
  ZendeskContentTag,
  ZendeskLabel,
  ZendeskListResponse,
  ZendeskLocalesResponse,
  ZendeskPermissionGroup,
  ZendeskSection,
  ZendeskTranslation,
  ZendeskUserSegment,
} from '../types';
import { loadArticleFormat } from '../utils/article-format';
import {
  arrangeDesiredOrder,
  computePositionWrites,
  hasPositionInversion,
  isPlacedAsRequested,
  type OrderedArticle,
  type ReorderTarget,
  type ReorderWrite,
} from '../utils/article-order';
import type { IntroLoss, Section, StrippedHeading } from '../utils/article-sections';
import {
  formatArticle,
  formatArticleSummary,
  formatAttachment,
  formatBrand,
  formatCategory,
  formatContentTag,
  formatLabel,
  formatList,
  formatNodeTranslationSummary,
  formatPermissionGroup,
  formatSection,
  formatTranslation,
  formatTranslationSummary,
  formatUserSegment,
  truncateIfNeeded,
} from '../utils/formatting';
import {
  buildCursorParams,
  buildOffsetParams,
  extractPaginationMeta,
  extractSearchPaginationMeta,
  PAGE_DESC,
  PER_PAGE_DESC,
} from '../utils/pagination';
import type { ToolCaller, ToolDefinition, ToolEnv } from './definitions';

// Byte-identical across the seven read/section/attachment tools that take an
// article id. Kept as one constant (like PER_PAGE_DESC/PAGE_DESC) so the "how to
// obtain it" guidance can't drift between copies. The two article-write tools
// use their own variant ("...to update" / "...whose translation to update").
const ARTICLE_ID_DESC = 'Article id, from list_articles or search_articles.';

// Shared `brand_id` input field factory. In unset/single mode the field is
// ABSENT from the schema (strict parsing rejects it); in multi/all mode it is
// REQUIRED (not .optional()) and described with the allowed set. The value may
// be a numeric brand id OR the brand's subdomain (the resolver accepts both),
// so the schema is a union — a bare z.number() would reject a documented
// subdomain like 'docs' at validation time, before resolution could accept it.
const brandIdField = (brandIds: string[] | undefined) => {
  if (!brandIds || brandIds.length === 0) return undefined;
  if (brandIds.length === 1 && brandIds[0] !== 'all') return undefined;
  const description =
    brandIds[0] === 'all'
      ? 'Brand of the Help Center to operate on, by id or subdomain. Required: any brand from list_brands.'
      : `Brand of the Help Center to operate on, by id or subdomain. Required: one of ${brandIds.join(', ')}.`;
  return z.union([z.number().int(), z.string().min(1)]).describe(description);
};

/**
 * Resolve which brand a call targets, enforcing the deploy allow-list.
 *
 * - unset: no brand override; a per-call brand_id is rejected (schema has no
 *   field for it, so this is a backstop for hand-crafted calls).
 * - single: the configured entry is the only brand; ANY per-call brand_id is
 *   rejected (hard lock, no escape — the schema has no field for it).
 * - multi: brand_id is REQUIRED; the per-call id is resolved and must match an
 *   allowed entry by id or resolved subdomain.
 * - all: brand_id is REQUIRED; any existing brand passes (validated by the
 *   resolver).
 *
 * Returns the brand's subdomain, or undefined for the account default.
 */
export const resolveBrand = async (
  perCall: number | string | undefined,
  brandIds: string[] | undefined,
  resolveSubdomain: (idOrSubdomain: string) => Promise<string>,
): Promise<string | undefined> => {
  if (!brandIds || brandIds.length === 0) {
    if (perCall !== undefined) {
      throw new Error(
        'brand_id is not accepted: this server was started without --brand-ids, so it targets the account default brand.',
      );
    }
    return undefined;
  }

  const isAll = brandIds.length === 1 && brandIds[0] === 'all';
  const isSingle = brandIds.length === 1 && !isAll;

  if (isSingle) {
    const locked = brandIds[0] as string;
    // Hard lock: the schema carries no brand_id field at all, so reaching here
    // with one means a hand-crafted call — rejected, no escape.
    if (perCall !== undefined) {
      throw new Error(
        `brand_id is not accepted: this server was started with --brand-ids ${locked}, which locks every Help Center operation to that brand. Omit brand_id.`,
      );
    }
    return resolveSubdomain(locked);
  }

  // multi or all: brand_id is required.
  if (perCall === undefined) {
    throw new Error(
      `brand_id is required: this server was started with --brand-ids ${brandIds.join(', ')}, so every brand-scoped Help Center call must name one.`,
    );
  }
  const resolved = await resolveSubdomain(String(perCall));
  if (isAll) return resolved;
  await assertAllowed(perCall, resolved, brandIds, resolveSubdomain);
  return resolved;
};

// multi-mode membership: an exact id/subdomain match short-circuits before any
// allow-list entry is resolved — a typo'd or since-deleted entry in --brand-ids
// must not break calls that name a valid brand. Remaining entries resolve with
// failures tolerated (allSettled): an unresolvable entry simply can't match, it
// doesn't take the whole call down with it.
const assertAllowed = async (
  perCall: number | string,
  resolved: string,
  brandIds: string[],
  resolveSubdomain: (idOrSubdomain: string) => Promise<string>,
): Promise<void> => {
  if (brandIds.includes(String(perCall))) return;
  const settled = await Promise.allSettled(brandIds.map((entry) => resolveSubdomain(entry)));
  const allowed = new Set<string>(brandIds);
  for (const r of settled) {
    if (r.status === 'fulfilled') allowed.add(r.value);
  }
  if (!allowed.has(resolved)) {
    throw new Error(
      `brand_id ${perCall} is not allowed: this server was started with --brand-ids ${brandIds.join(', ')}. Allowed: ${[...allowed].join(', ')}.`,
    );
  }
};

// The article `translations` list endpoint, shared by every read tool that
// needs the available locales. It is also the only endpoint that returns the
// per-translation `outdated` flag (a single-translation GET omits it), so
// callers checking staleness must go through here.
const listTranslations = (
  subdomain: string,
  token: string,
  articleId: number,
): Promise<ZendeskTranslation[]> =>
  helpCenterGet<{ translations: ZendeskTranslation[] }>(
    subdomain,
    token,
    `/articles/${articleId}/translations`,
  ).then((res) => res.translations);

// --- Section / category translations.
//
// Same endpoint family as articles, same translation object, but `title` is the
// localized *name* and `body` the localized *description*. The tools speak
// name/description (what list_sections/list_categories return) and map here.
//
// The two levels are ISO: anything done to one must be done to the other.
type TreeNodeKind = 'sections' | 'categories';

const NODE_LABEL: Record<TreeNodeKind, string> = {
  sections: 'section',
  categories: 'category',
};

// `locales` only narrows the response; the result is filtered locally anyway, so
// an unapplied server-side filter stays correct. Lower-cased because whether that
// filter is case-sensitive is undocumented: if it is, a caller's "FR" comes back
// empty and every node reads as untranslated.
const listNodeTranslations = (
  subdomain: string,
  token: string,
  kind: TreeNodeKind,
  nodeId: number,
  locale?: string,
): Promise<ZendeskTranslation[]> =>
  helpCenterGet<{ translations: ZendeskTranslation[] }>(
    subdomain,
    token,
    `/${kind}/${nodeId}/translations`,
    locale ? { locales: locale.toLowerCase() } : undefined,
  ).then((res) => res.translations ?? []);

// Case-insensitive: a caller may well pass "FR" or a copy-paste from Guide.
const findTranslation = (
  translations: ZendeskTranslation[],
  locale: string,
): ZendeskTranslation | undefined => {
  const wanted = locale.toLowerCase();
  return translations.find((t) => t.locale.toLowerCase() === wanted);
};

/**
 * Create-or-update a section/category translation in one call. The POST-vs-PUT
 * probe spares the caller a listing round-trip, or the 400 a duplicate POST
 * returns. Only the fields passed are sent on update, so omitting `description`
 * never blanks it and omitting `draft` never (un)publishes by accident.
 */
const upsertNodeTranslation = async (
  subdomain: string,
  token: string,
  kind: TreeNodeKind,
  nodeId: number,
  input: { locale: string; name?: string; description?: string; draft?: boolean },
): Promise<{ translation: ZendeskTranslation; created: boolean }> => {
  const { locale, name, description, draft } = input;
  const existing = findTranslation(
    await listNodeTranslations(subdomain, token, kind, nodeId, locale),
    locale,
  );

  if (!existing) {
    if (name === undefined) {
      throw new Error(
        `${NODE_LABEL[kind]} #${nodeId} has no "${locale}" translation yet, so one has to be created and "name" is required. Pass the localized name, or call list_${NODE_LABEL[kind]}_translations to see which locales already exist.`,
      );
    }
    const { translation } = await helpCenterPost<{ translation: ZendeskTranslation }>(
      subdomain,
      token,
      `/${kind}/${nodeId}/translations`,
      { translation: { locale, title: name, body: description ?? '', draft: draft ?? false } },
    );
    return { translation, created: true };
  }

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates['title'] = name;
  if (description !== undefined) updates['body'] = description;
  if (draft !== undefined) updates['draft'] = draft;
  // An empty payload would round-trip and be reported as an update: a lie.
  if (Object.keys(updates).length === 0) {
    throw new Error(
      `Nothing to write: ${NODE_LABEL[kind]} #${nodeId} already has a "${existing.locale}" translation, so pass at least one of "name", "description" or "draft" to change it (draft: false publishes it).`,
    );
  }
  // Zendesk's spelling, not the caller's, so the PUT path matches.
  const { translation } = await helpCenterPut<{ translation: ZendeskTranslation }>(
    subdomain,
    token,
    `/${kind}/${nodeId}/translations/${existing.locale}`,
    { translation: updates },
  );
  return { translation, created: false };
};

const nodeTranslationWriteText = (
  kind: TreeNodeKind,
  nodeId: number,
  translation: ZendeskTranslation,
  created: boolean,
): string =>
  [
    `Translation ${created ? 'created' : 'updated'} for ${NODE_LABEL[kind]} #${nodeId} in "${
      translation.locale
    }" (${translation.draft ? 'draft, not visible to end users' : 'published'}).`,
    '',
    formatNodeTranslationSummary(translation),
  ].join('\n');

// --- find_translation_gaps.
//
// A gap is no translation, or a draft one — different fixes, and
// `list_sections?locale=…` shows neither: missing is absent, draft is listed
// under its draft name (#225). The draft flag decides, and it rides on
// `include=translations` (#226): two listings cover the tree, against one request
// per node.
const TRANSLATIONS_SIDELOAD = 'translations';

type GapReason = 'missing' | 'draft';

interface TranslationGap {
  id: number;
  name: string;
  reason: GapReason;
}

const GAP_REASON_TEXT: Record<GapReason, string> = {
  missing: 'no translation',
  draft: 'draft translation (not published)',
};

const classifyGap = (
  node: { id: number; name: string },
  translations: ZendeskTranslation[],
  locale: string,
): TranslationGap | null => {
  const translation = findTranslation(translations, locale);
  if (!translation) return { id: node.id, name: node.name, reason: 'missing' };
  return translation.draft ? { id: node.id, name: node.name, reason: 'draft' } : null;
};

interface GapReport {
  locale: string;
  activeLocales: string[];
  categoryGaps: TranslationGap[];
  sectionGaps: TranslationGap[];
  /** Nodes whose translations the listing actually carried, so a verdict is possible. */
  scanned: { categories: number; sections: number };
  found: { categories: number; sections: number };
  /** True when the category or section listing itself spilled past one page. */
  listingIncomplete: boolean;
  /** True when the caller already scoped the audit to one category. */
  categoryScoped: boolean;
}

/**
 * Split a listing into the nodes that can be classified and the rest. A node
 * whose `translations` key is absent was answered without the sideload, and
 * reading that as "no translation" would report an entire Help Center as one big
 * gap — so it counts as unclassified and the report says how many.
 */
const withSideloadedTranslations = <T extends { translations?: ZendeskTranslation[] }>(
  nodes: T[],
): (T & { translations: ZendeskTranslation[] })[] =>
  nodes.filter((node): node is T & { translations: ZendeskTranslation[] } =>
    Array.isArray(node.translations),
  );

const renderGapLines = (
  heading: string,
  gaps: TranslationGap[],
  scanned: number,
  found: number,
): string[] => {
  const header = `## ${heading} (${scanned} scanned)`;
  if (gaps.length > 0) {
    return [
      header,
      ...gaps.map((gap) => `- **${gap.name}** (${gap.id}) — ${GAP_REASON_TEXT[gap.reason]}`),
    ];
  }
  // Three distinct states, and conflating any two reads as a false all-clear:
  // nothing at this level, nothing the listing could answer for, nothing missing.
  if (scanned === 0) {
    return [
      header,
      found === 0
        ? '_(none to scan at this level)_'
        : `_(none classified — the listing answered without the sideload for all ${found}, see the note below)_`,
    ];
  }
  return [header, '_(none — every one scanned has a published translation)_'];
};

// Scoping fetches the one category rather than filtering the one-page listing,
// which would report "0 scanned" for a category further down, and an empty tree
// instead of a 404 for a wrong id.
const fetchGapCategories = async (
  subdomain: string,
  token: string,
  categoryId: number | undefined,
): Promise<{ categories: ZendeskCategory[]; hasMore: boolean }> => {
  if (categoryId !== undefined) {
    // Measured on a live tenant, this show endpoint included (#226): the sideload
    // is embedded in the node here too, not hung off the top level as sideloads
    // usually are. Reading `category.translations` is therefore the whole story on
    // the scoped path, not just on the listings.
    const { category } = await helpCenterGet<{ category: ZendeskCategory }>(
      subdomain,
      token,
      `/categories/${categoryId}`,
      { include: TRANSLATIONS_SIDELOAD },
    );
    return { categories: [category], hasMore: false };
  }
  const response = await helpCenterGet<ZendeskListResponse<ZendeskCategory>>(
    subdomain,
    token,
    '/categories',
    { ...buildCursorParams(MAX_PAGE_SIZE, undefined), include: TRANSLATIONS_SIDELOAD },
  );
  const categories = response.categories ?? [];
  return { categories, hasMore: extractPaginationMeta(response, categories.length).has_more };
};

// The bottom line, in the states that must not be conflated: gaps found, nothing
// classifiable (which is not an all-clear), an all-clear over part of the tree
// (also not one), and a genuine all-clear.
const renderGapVerdict = (report: GapReport, gapCount: number, unclassified: number): string => {
  const { locale, scanned } = report;
  if (gapCount > 0) {
    return `${gapCount} node(s) need a published "${locale}" translation. Fix a category with set_category_translation and a section with set_section_translation, passing draft: false to publish.`;
  }
  if (scanned.categories + scanned.sections === 0 && unclassified > 0) {
    return `Nothing could be classified, so this audit says nothing about "${locale}" either way. See the note below.`;
  }
  const allClear = `No gaps: all ${scanned.categories} category/ies and ${scanned.sections} section(s) scanned have a published "${locale}" translation.`;
  return unclassified > 0
    ? `${allClear} This is not a clean bill of health for the whole tree: ${unclassified} other node(s) could not be classified — see the note below.`
    : allClear;
};

// No pagination parameter exists, so a truncated report must name a lever that
// does: an unscoped audit narrows with category_id; a scoped one that saw every
// section is done; one whose listing spilled past a page is neither, and "re-run
// it" would hide the sections never reached (#265).
const gapAdvice = (report: GapReport): string => {
  if (!report.categoryScoped) {
    return 'find_translation_gaps takes no pagination parameter; narrow the audit to one branch of the tree with category_id instead.';
  }
  return report.listingIncomplete
    ? 'find_translation_gaps takes no pagination parameter and this category holds more sections than one page, so the section listing is incomplete: list the rest with list_sections (category_id, following its cursor) and read them with list_section_translations.'
    : 'find_translation_gaps takes no pagination parameter, and this audit is already scoped to one category: fix the nodes above with set_category_translation / set_section_translation, then re-run it.';
};

const renderGapReport = (report: GapReport): string => {
  const { locale, categoryGaps, sectionGaps, scanned, found } = report;
  const gapCount = categoryGaps.length + sectionGaps.length;
  const totalFound = found.categories + found.sections;
  const unclassified = totalFound - (scanned.categories + scanned.sections);
  return truncateIfNeeded(
    [
      `# Translation gaps — "${locale}"`,
      '',
      ...(report.activeLocales.some((l) => l.toLowerCase() === locale.toLowerCase())
        ? []
        : [
            `> ⚠ "${locale}" is not an active locale of this Help Center (active: ${report.activeLocales.join(
              ', ',
            )}), so everything below reads as untranslated. Check the spelling, or activate the language in Guide first.`,
            '',
          ]),
      ...renderGapLines('Categories', categoryGaps, scanned.categories, found.categories),
      '',
      ...renderGapLines('Sections', sectionGaps, scanned.sections, found.sections),
      '',
      renderGapVerdict(report, gapCount, unclassified),
      ...(unclassified > 0
        ? [
            '',
            `_Note: ${unclassified} of ${totalFound} node(s) came back without the \`translations\` sideload, so their state is unknown and none of them is reported above (covered: ${scanned.categories}/${found.categories} categories, ${scanned.sections}/${found.sections} sections). Read one of them with list_category_translations / list_section_translations, which query the node directly._`,
          ]
        : []),
      ...(report.listingIncomplete
        ? [
            '',
            report.categoryScoped
              ? `_Note: this category holds more than ${MAX_PAGE_SIZE} sections, so only the first page was considered. List the rest with list_sections (category_id, following its cursor) and read them with list_section_translations._`
              : `_Note: this Help Center has more than ${MAX_PAGE_SIZE} categories or sections, so only the first page of each was considered. Narrow the scan with category_id to audit the rest._`,
          ]
        : []),
    ].join('\n'),
    gapAdvice(report),
  );
};

const largeArticleHint = (body: string, sectionCount: number): string | null => {
  if (body.length < LARGE_ARTICLE_BODY_CHARS && sectionCount < LARGE_ARTICLE_SECTION_COUNT) {
    return null;
  }
  return [
    `> ⚠ Large article (${body.length} chars, ${sectionCount} sections).`,
    '> For targeted edits, prefer get_article_outline + get_article_section +',
    '> update_article_section to avoid re-sending the full body on each write.',
    '',
  ].join('\n');
};

// Returned when a reorder's position writes are (or would be) silently ignored
// because the section is sorted automatically. No API field exposes the sort
// mode, so we name the section and the UI steps rather than fabricate an admin
// deep-link, none being stable across Guide versions.
const autoSortNotice = (sectionId: number, applied?: number): string =>
  [
    applied === undefined
      ? `Section #${sectionId} looks like it is sorted automatically, so a manual reorder would have no visible effect.`
      : `Wrote ${applied} article position(s), but the display order of section #${sectionId} did not change — the section is sorted automatically, so positions are ignored.`,
    'To order its articles manually: in Guide, open the section, choose "Edit section", set "Order articles by" to Manual, then re-run this tool.',
  ].join(' ');

// --- compare_translations report lines. Each is a pure function of data the
// handler already fetched, kept out of it so the handler reads as the sequence
// of signals it produces rather than the arithmetic behind each one.

// Primary staleness signal: a source edited after the target is very likely
// ahead of it. Always available and, for API or external translation workflows,
// far more useful than Zendesk's `outdated` flag (below). updated_at is ISO-8601
// UTC, so a lexical compare is order-correct.
const renderFreshnessLine = (
  sourceUpdatedAt: string,
  targetUpdatedAt: string,
  targetLocale: string,
): string => {
  const srcMs = Date.parse(sourceUpdatedAt);
  const tgtMs = Date.parse(targetUpdatedAt);
  const label = `- **Freshness (target ${targetLocale})**`;

  if (!Number.isFinite(srcMs) || !Number.isFinite(tgtMs)) {
    return `${label}: unknown (could not compare edit timestamps).`;
  }
  if (srcMs <= tgtMs) {
    return `${label}: up to date (source has not been edited since this translation).`;
  }
  const days = Math.floor((srcMs - tgtMs) / 86_400_000);
  const gap = days >= 1 ? `${days} day(s)` : 'less than a day';
  return `${label}: source was edited ${gap} after this translation → likely behind, review recommended.`;
};

// Secondary signal: Zendesk's `outdated` flag, set only through Guide's native
// "mark translations out of date" workflow and NOT by API edits, so it usually
// stays false whatever the real staleness — an overlay on the freshness signal,
// never the verdict. Matched case-insensitively, as the list endpoint reports
// locales lowercased.
const renderOutdatedLine = (translations: ZendeskTranslation[], targetLocale: string): string => {
  const targetLocaleKey = targetLocale.toLowerCase();
  const entry = translations.find((t) => t.locale.toLowerCase() === targetLocaleKey);
  const label = `- **Zendesk outdated flag (target ${targetLocale})**`;

  if (entry?.outdated === undefined) return `${label}: unknown.`;
  if (entry.outdated) return `${label}: yes — explicitly marked out of date in Guide.`;
  return `${label}: no (only set via Guide's own edit workflow; "no" does not by itself mean current — rely on Freshness above).`;
};

// Structural verdict: language-neutral (section count + heading-tag sequence),
// unlike word counts. A mismatch means the index-matched rows may not line up.
const renderStructureLine = (sourceSections: Section[], targetSections: Section[]): string => {
  const sourceTags = sourceSections.map((s) => s.headingTag).join(',');
  const targetTags = targetSections.map((s) => s.headingTag).join(',');
  const aligned = sourceSections.length === targetSections.length && sourceTags === targetTags;
  return aligned
    ? `- **Structure**: ${sourceSections.length} sections in both locales — aligned.`
    : `- **Structure**: ${sourceSections.length} source vs ${targetSections.length} target sections — MISMATCH; the per-index rows below may be misaligned.`;
};

// Whether an index has a counterpart on both sides. `extra` means the target
// has a section the source does not; `missing` is the reverse.
const sectionRowStatus = (
  source: Section | undefined,
  target: Section | undefined,
): 'ok' | 'missing' | 'extra' => {
  if (!target) return 'missing';
  if (!source) return 'extra';
  return 'ok';
};

// Index-matched section table. Rows past one side's end are reported as
// missing/extra rather than dropped, so a length mismatch stays visible.
const renderSectionRows = (sourceSections: Section[], targetSections: Section[]): string[] => {
  const rows = [
    '| Idx | Heading | Status | Source words | Target words |',
    '| --- | --- | --- | --- | --- |',
  ];
  const maxLen = Math.max(sourceSections.length, targetSections.length);

  for (let i = 0; i < maxLen; i += 1) {
    const src = sourceSections[i];
    const tgt = targetSections[i];
    const heading = src?.heading ?? tgt?.heading ?? '';
    const status = sectionRowStatus(src, tgt);
    rows.push(
      `| ${i} | ${heading} | ${status} | ${src?.wordCount ?? 0} | ${tgt?.wordCount ?? 0} |`,
    );
  }
  return rows;
};

// Help Center paths carry two independent optional scopes: a locale prefix and a
// parent-resource segment. Composing them beats enumerating the cross-product —
// the locale-scoped variant is what a locale-dependent section sort mode
// requires (see fetchSectionOrder). Truthiness matches the previous ternary
// chains: a 0 id contributes no segment.
const localePrefix = (locale: string | undefined): string => (locale ? `/${locale}` : '');

const articleListPath = (sectionId: number | undefined, locale: string | undefined): string =>
  `${localePrefix(locale)}${sectionId ? `/sections/${sectionId}` : ''}/articles`;

const sectionListPath = (categoryId: number | undefined, locale: string | undefined): string =>
  `${localePrefix(locale)}${categoryId ? `/categories/${categoryId}` : ''}/sections`;

// Scan-cost footer for the promoted-article listing. Three states, so a nested
// ternary at the call site: capped (coverage may be incomplete), multi-page
// (costly, don't repeat), or a single cheap page (no note at all).
const scanCostNote = (truncated: boolean, pagesScanned: number, cost: string): string => {
  if (truncated) {
    return `\n\n_Note: the scan hit its ${ARTICLE_RESOURCES_SCAN_MAX_PAGES}-page cap (${cost}), so promoted articles deeper in the catalog may be missing. This call is costly on this Help Center — avoid repeating it; raise ARTICLE_RESOURCES_SCAN_MAX_PAGES to widen coverage._`;
  }
  if (pagesScanned > 1) {
    return `\n\n_Note: this scan cost ${cost}; this tool performs a fresh scan every call (no caching), so avoid calling it again right away._`;
  }
  return '';
};

// `first`/`last` are absolute; `before`/`after` are relative and need a peer.
const needsReferenceArticle = (target: ReorderTarget): boolean =>
  target === 'before' || target === 'after';

// Cross-field rules the flat input schema cannot express: a relative target
// requires a reference, an absolute one must not carry it, and no article can be
// positioned relative to itself. Throws naming the offending combination.
const assertReorderParamsCoherent = (
  articleId: number,
  target: ReorderTarget,
  referenceArticleId: number | undefined,
): void => {
  const needsReference = needsReferenceArticle(target);
  if (needsReference && referenceArticleId === undefined) {
    throw new Error(
      `target "${target}" requires reference_article_id (the article to move ${target}).`,
    );
  }
  if (!needsReference && referenceArticleId !== undefined) {
    throw new Error(
      `reference_article_id must be omitted when target is "${target}" (it only applies to "before"/"after").`,
    );
  }
  if (referenceArticleId !== undefined && referenceArticleId === articleId) {
    throw new Error('reference_article_id must differ from article_id.');
  }
};

interface SectionUpdateReport {
  stripped: StrippedHeading | null;
  contentHeadings: number;
  introLost: IntroLoss;
  sectionIndex: number;
  sectionsBefore: number;
  sectionsAfter: number;
}

const structureWarning = (r: SectionUpdateReport): string[] => {
  if (r.introLost === 'empty') {
    if (r.sectionsBefore === 1) {
      return [
        'Warning: content is empty and the intro was the only section, so the article body is now empty.',
      ];
    }
    return [
      `Warning: content is empty, so the intro no longer exists and every later section index moved down by one (article: ${r.sectionsAfter} sections, was ${r.sectionsBefore}). Call get_article_outline before the next edit.`,
    ];
  }
  if (r.introLost === 'heading-led') {
    return [
      `Warning: content starts with a heading, so the intro no longer exists and section [${r.sectionIndex}] is now a heading section (article: ${r.sectionsAfter} sections, was ${r.sectionsBefore}). Call get_article_outline before the next edit.`,
    ];
  }
  if (r.contentHeadings > 0) {
    return [
      `Warning: content contains ${r.contentHeadings} heading(s) (h1-h3), so the article now has ${r.sectionsAfter} sections (was ${r.sectionsBefore}); indexes after [${r.sectionIndex}] shifted. Call get_article_outline before the next edit.`,
    ];
  }
  return [];
};

const sectionUpdateNotes = (r: SectionUpdateReport): string[] => [
  ...(r.stripped
    ? [
        `Note: removed a leading <${r.stripped.tag}> "${r.stripped.text}" from content; the section heading is kept automatically and is not part of content.`,
      ]
    : []),
  ...structureWarning(r),
];

/**
 * Build the `list_brands` tool when the server runs in multi/all mode; an empty
 * array otherwise. It is the discovery source for the required per-call
 * `brand_id`: in single-lock or unset mode the brand is implicit, the schemas
 * carry no `brand_id` field, and the tool stays hidden. In multi mode (not
 * 'all') the listing is filtered to the allowed brands.
 */
const createListBrandsTool = (env: ToolEnv): ToolDefinition[] => {
  const { subdomain, brandIds } = env;
  if (brandIds === undefined) return [];
  const isAll = brandIds.length === 1 && brandIds[0] === 'all';
  if (brandIds.length === 1 && !isAll) return [];
  return [
    {
      name: 'list_brands',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Zendesk Brands',
      description:
        "List the Zendesk account's brands (id, name, URL, default/active flags) from the Support API. Multi-brand Guide accounts have one Help Center per brand: find the brand id here, then pass it as brand_id (id or subdomain) — REQUIRED on every brand-scoped Help Center tool in multi/all mode.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (_params, { caller }) => {
        const token = await caller.getToken();
        // Account-wide Support API, so unscoped. Same walk as the resolver but
        // not its cache: discovery must show a fresh, complete listing.
        const brands = await fetchAllBrands(subdomain, token);
        const visible = isAll
          ? brands
          : brands.filter((b) => brandIds.includes(String(b.id)) || brandIds.includes(b.subdomain));
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                visible,
                formatBrand,
                undefined,
                'Pass a brand id as brand_id to any Help Center tool to operate on that brand.',
              ),
            },
          ],
        };
      },
    },
  ];
};

export const createHelpCenterTools = (env: ToolEnv): ToolDefinition[] => {
  const { subdomain, brandIds } = env;
  const brandIdSchema = brandIdField(brandIds);
  // Spread of an empty object adds no field: in unset/single mode the schemas
  // carry no brand_id at all (strict parsing then rejects it); in multi/all
  // mode this one object holds the REQUIRED field shared by every schema below.
  const brandIdPart: Record<string, z.ZodType> = brandIdSchema ? { brand_id: brandIdSchema } : {};

  // Brand id-or-subdomain -> the EFFECTIVE subdomain the Help Center calls run
  // against, honouring the deploy allow-list: resolveBrand enforces it
  // (mismatched per-call ids throw here, before any request), then the cached
  // resolver maps the entry to its subdomain — a brand is only ever
  // <subdomain>.zendesk.com, so that subdomain IS the helpCenter* argument.
  // Undefined means the account default brand — no resolution, no extra request.
  const resolveHcSubdomain = async (
    caller: ToolCaller,
    brand_id: number | string | undefined,
  ): Promise<string> => {
    const brandSub = await resolveBrand(brand_id, brandIds, caller.resolveBrandSubdomain);
    return brandSub ?? subdomain;
  };

  // A section's articles in the EFFECTIVE display order an end user sees (no
  // sort_by), paginated to completion so reorder and its verification see all.
  //
  // MUST be locale-scoped: without sort_by the endpoint falls back to the
  // section's "Order articles by", and a locale-dependent mode makes the
  // non-locale endpoint answer HTTP 400.
  const fetchSectionOrder = async (
    sectionId: number,
    locale: string,
    token: string,
    hcSubdomain: string,
  ): Promise<OrderedArticle[]> => {
    const order: OrderedArticle[] = [];
    let cursor: string | undefined;
    do {
      const response = await helpCenterGet<ZendeskListResponse<ZendeskArticle>>(
        hcSubdomain,
        token,
        `/${locale}/sections/${sectionId}/articles`,
        buildCursorParams(MAX_PAGE_SIZE, cursor),
      );
      const articles = response.articles ?? [];
      for (const article of articles) {
        order.push({ id: article.id, position: article.position });
      }
      const meta = extractPaginationMeta(response, articles.length);
      cursor = meta.has_more && meta.after_cursor ? meta.after_cursor : undefined;
    } while (cursor);
    return order;
  };

  // A relative reorder only makes sense inside one section. When the reference
  // is absent from the section listing, tell the caller which of the two cases
  // it is — "no such article" and "exists, but elsewhere" need different fixes.
  const assertReferenceInSection = async (
    effective: OrderedArticle[],
    referenceArticleId: number,
    articleId: number,
    sectionId: number,
    token: string,
    hcSubdomain: string,
  ): Promise<void> => {
    if (effective.some((a) => a.id === referenceArticleId)) return;

    let detail = 'was not found';
    try {
      const { article: ref } = await helpCenterGet<{ article: ZendeskArticle }>(
        hcSubdomain,
        token,
        `/articles/${referenceArticleId}`,
      );
      detail = `is in section #${ref.section_id}, not section #${sectionId}`;
    } catch {
      // 404 or similar → keep the "was not found" wording.
    }
    throw new Error(
      `Reference article #${referenceArticleId} ${detail}. It must be in the same section (#${sectionId}) as article #${articleId}.`,
    );
  };

  // Positions are absolute, so a re-run after a failure recomputes against the
  // current state and resumes — it never double-applies. Returns how many writes
  // landed; on failure the error names that count so the caller can resume.
  const applyPositionWrites = async (
    writes: ReorderWrite[],
    articleId: number,
    token: string,
    hcSubdomain: string,
  ): Promise<number> => {
    let applied = 0;
    for (const write of writes) {
      try {
        await helpCenterPut(hcSubdomain, token, `/articles/${write.id}`, {
          article: { position: write.position },
        });
        applied += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Reorder of article #${articleId} failed after ${applied}/${writes.length} position write(s) (on article #${write.id}): ${reason} Positions are written absolutely, so re-running the identical call is safe and resumes where it stopped.`,
          { cause: error },
        );
      }
    }
    return applied;
  };

  return [
    // list_brands is only exposed when the server was started with several
    // brands (or 'all'): it is the discovery source for the required per-call
    // brand_id. In single-lock or unset mode it is absent — the brand is
    // implicit and the schema carries no brand_id field at all.
    ...createListBrandsTool(env),
    {
      name: 'search_articles',
      namespace: 'help_center',
      readOnly: true,
      title: 'Search Help Center Articles',
      description:
        'Search Help Center articles by full text; returns metadata (no body) and the total count. Full content: get_article.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Plain keywords matched against titles and bodies.'),
        locale: z
          .string()
          .optional()
          .describe('Only articles in this locale (e.g. "en-us", "fr").'),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe(PER_PAGE_DESC),
        page: z.number().int().min(1).default(1).describe(PAGE_DESC),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { query, locale, per_page, page, brand_id } = params as {
          query: string;
          locale?: string;
          per_page: number;
          page: number;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const p: Record<string, string> = { query, ...buildOffsetParams(per_page, page) };
        if (locale) p['locale'] = locale;
        const response = await helpCenterGet<ZendeskListResponse<ZendeskArticle>>(
          hcSubdomain,
          token,
          '/articles/search',
          p,
        );
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                response.results ?? [],
                formatArticleSummary,
                extractSearchPaginationMeta(response, per_page, page),
              ),
            },
          ],
        };
      },
    },
    {
      name: 'get_article',
      namespace: 'help_center',
      readOnly: true,
      title: 'Get Help Center Article',
      description:
        'Get an article with its full HTML body, metadata, source_locale and translations. For a large article, get_article_outline then get_article_section costs fewer tokens.',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        locale: z
          .string()
          .optional()
          .describe('Locale of the translation to return; omit for the source.'),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { article_id, locale, brand_id } = params as {
          article_id: number;
          locale?: string;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const path = locale ? `/${locale}/articles/${article_id}` : `/articles/${article_id}`;
        const { article } = await helpCenterGet<{ article: ZendeskArticle }>(
          hcSubdomain,
          token,
          path,
          undefined,
        );
        const translations = await listTranslations(hcSubdomain, token, article_id);
        const { parseSections } = await loadArticleFormat();
        const hint = largeArticleHint(article.body, parseSections(article.body).length);
        const text =
          (hint ?? '') +
          formatArticle(article) +
          `\n\n**Available translations**: ${translations.map((t) => t.locale).join(', ')}`;
        return {
          content: [
            {
              type: 'text',
              text: truncateIfNeeded(
                text,
                'get_article takes no pagination parameter; read a long article one part at a time with get_article_outline then get_article_section.',
              ),
            },
          ],
        };
      },
    },
    {
      name: 'list_categories',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Help Center Categories',
      description:
        'List Help Center categories (top of category → section → article) with id, name and locale. Drill down with list_sections, then list_articles.',
      inputSchema: z.object({
        locale: z
          .string()
          .optional()
          .describe(
            'Locale of the names (e.g. "en-us", "fr"); defaults to the Help Center default.',
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Categories per page.'),
        cursor: z
          .string()
          .optional()
          .describe('Cursor from the previous response; omit for the first page.'),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { locale, page_size, cursor, brand_id } = params as {
          locale?: string;
          page_size: number;
          cursor?: string;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const path = `${localePrefix(locale)}/categories`;
        const response = await helpCenterGet<ZendeskListResponse<ZendeskCategory>>(
          hcSubdomain,
          token,
          path,
          buildCursorParams(page_size, cursor),
        );
        const categories = response.categories ?? [];
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                categories,
                formatCategory,
                extractPaginationMeta(response, categories.length),
              ),
            },
          ],
        };
      },
    },
    {
      name: 'list_sections',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Help Center Sections',
      description:
        'List Help Center sections (the level between category and article) with id, name, category_id and locale. Use a section id with list_articles.',
      inputSchema: z.object({
        category_id: z
          .number()
          .int()
          .optional()
          .describe('Only sections of this category (id from list_categories).'),
        locale: z
          .string()
          .optional()
          .describe(
            'Locale of the names (e.g. "en-us", "fr"); defaults to the Help Center default.',
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Sections per page.'),
        cursor: z
          .string()
          .optional()
          .describe('Cursor from the previous response; omit for the first page.'),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { category_id, locale, page_size, cursor, brand_id } = params as {
          category_id?: number;
          locale?: string;
          page_size: number;
          cursor?: string;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const response = await helpCenterGet<ZendeskListResponse<ZendeskSection>>(
          hcSubdomain,
          token,
          sectionListPath(category_id, locale),
          buildCursorParams(page_size, cursor),
        );
        const sections = response.sections ?? [];
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                sections,
                formatSection,
                extractPaginationMeta(response, sections.length),
              ),
            },
          ],
        };
      },
    },
    {
      name: 'list_articles',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Help Center Articles',
      description:
        'List article metadata (no body), optionally by section or locale, sorted, or with translation locales. Full content: get_article.',
      inputSchema: z.object({
        section_id: z
          .number()
          .int()
          .optional()
          .describe('Only articles of this section (id from list_sections).'),
        locale: z
          .string()
          .optional()
          .describe('Only this locale, e.g. "en-us" or "fr"; defaults to the default locale.'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Articles per page.'),
        cursor: z
          .string()
          .optional()
          .describe('Cursor from the previous response; omit for the first page.'),
        sort_by: z
          .enum(['created_at', 'updated_at', 'position', 'title'])
          .default('position')
          .describe('Sort field; "position" is the manual order set in Guide.'),
        sort_order: z
          .enum(['asc', 'desc'])
          .default('asc')
          .describe('Sort direction: ascending or descending.'),
        include_translations: z
          .boolean()
          .default(false)
          .describe(
            "Add each article's translation locales (one extra call per article); re-send it with each cursor.",
          ),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const {
          section_id,
          locale,
          page_size,
          cursor,
          sort_by,
          sort_order,
          include_translations,
          brand_id,
        } = params as {
          section_id?: number;
          locale?: string;
          page_size: number;
          cursor?: string;
          sort_by: string;
          sort_order: string;
          include_translations: boolean;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const response = await helpCenterGet<ZendeskListResponse<ZendeskArticle>>(
          hcSubdomain,
          token,
          articleListPath(section_id, locale),
          { ...buildCursorParams(page_size, cursor), sort_by, sort_order },
        );
        const articles = response.articles ?? [];
        if (!include_translations) {
          return {
            content: [
              {
                type: 'text',
                text: formatList(
                  articles,
                  formatArticleSummary,
                  extractPaginationMeta(response, articles.length),
                ),
              },
            ],
          };
        }
        const formatted = await Promise.all(
          articles.map(async (article) => {
            const translations = await listTranslations(hcSubdomain, token, article.id);
            const locales = translations.map((t) => t.locale).join(', ');
            return `${formatArticleSummary(article)}\n- **Translations**: ${locales}`;
          }),
        );
        const meta = extractPaginationMeta(response, articles.length);
        const header = meta.count
          ? `Results: ${meta.count}${meta.has_more ? ` | More available (cursor: ${meta.after_cursor})` : ''}`
          : '';
        const text = [header, ...formatted].filter(Boolean).join('\n\n');
        return { content: [{ type: 'text', text: truncateIfNeeded(text) }] };
      },
    },
    {
      name: LIST_PROMOTED_ARTICLES_TOOL,
      namespace: 'help_center',
      readOnly: true,
      title: 'List Promoted Help Center Articles',
      description:
        'List promoted ("featured") articles, shown at the top of their sections. Metadata only, default locale (full content: get_article). Each call scans article pages afresh (one request each, up to 20 by default), so avoid repeating it. On a very large Help Center some may be missed, which the output flags. To promote or unpromote: update_article with `promoted` (Guide admin rights).',
      inputSchema: z.object({
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { brand_id } = params as { brand_id?: number | string };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const { articles, truncated, pagesScanned } = await fetchPromotedArticles(
          hcSubdomain,
          token,
          ARTICLE_RESOURCES_SCAN_MAX_PAGES,
        );
        const header = `Promoted (featured) articles: ${articles.length}`;
        const body = articles.length
          ? articles.map(formatArticleSummary).join('\n\n')
          : '_No promoted articles found._';
        // Surface the API cost to the caller. No silent caps: if the scan was
        // bounded, say so; and when it fanned out to several requests, tell the LLM
        // it is a costly call so it doesn't re-issue it needlessly.
        const cost = `${pagesScanned} Zendesk API request${pagesScanned === 1 ? '' : 's'}`;
        const note = scanCostNote(truncated, pagesScanned, cost);
        return {
          content: [
            {
              type: 'text',
              text: truncateIfNeeded(
                `${header}\n\n${body}${note}`,
                'list_promoted_articles takes no filter parameters, so this listing cannot be narrowed from the call; read a single article with get_article.',
              ),
            },
          ],
        };
      },
    },
    {
      name: 'list_article_translations',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Article Translations',
      description:
        "List an article's translations: locale, title, draft, updated_at (no body). Full translated content: get_article with locale.",
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { article_id, brand_id } = params as {
          article_id: number;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const translations = await listTranslations(hcSubdomain, token, article_id);
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                translations,
                formatTranslationSummary,
                undefined,
                'list_article_translations takes only article_id, so this listing cannot be narrowed from the call; read one locale in full with get_article.',
              ),
            },
          ],
        };
      },
    },
    {
      name: 'create_article_translation',
      namespace: 'help_center',
      readOnly: false,
      title: 'Create Article Translation',
      description:
        'Add an article translation in a locale that has none yet, and return it (locale, title, draft state). To change an existing one use update_article_translation; list_article_translations shows which exist.',
      inputSchema: z.object({
        article_id: z.number().int().describe('Article id, from list_articles or search_articles.'),
        locale: z.string().describe('Locale of the new translation (e.g. "fr", "de").'),
        title: z.string().min(1).describe('Translated article title.'),
        body: z.string().min(1).describe('Full translated body, in HTML.'),
        draft: z
          .boolean()
          .default(false)
          .describe('true keeps it a draft, hidden from end users; false publishes it.'),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { article_id, locale, title, body, draft, brand_id } = params as {
          article_id: number;
          locale: string;
          title: string;
          body: string;
          draft: boolean;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const { translation } = await helpCenterPost<{ translation: ZendeskTranslation }>(
          hcSubdomain,
          token,
          `/articles/${article_id}/translations`,
          { translation: { locale, title, body, draft } },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Translation created for article #${article_id} in "${locale}".\n\n${formatTranslation(translation)}`,
            },
          ],
        };
      },
    },
    {
      name: 'update_article_translation',
      namespace: 'help_center',
      readOnly: false,
      title: 'Update Article Translation',
      description:
        "Replace an article's title or full body in one locale, source or translation. To edit one or a few sections, prefer update_article_section: this re-sends the whole body.",
      inputSchema: z.object({
        article_id: z.number().int().describe('Article id, from list_articles or search_articles.'),
        locale: z
          .string()
          .describe(
            'Locale to update, e.g. "fr"; the source_locale (from get_article) edits the original.',
          ),
        title: z.string().optional().describe('New title for this locale.'),
        body: z.string().optional().describe('New full body in HTML, replacing the whole body.'),
        draft: z
          .boolean()
          .optional()
          .describe('true keeps this translation a draft; false publishes it.'),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { article_id, locale, brand_id, ...updates } = params as {
          article_id: number;
          locale: string;
          brand_id?: number | string;
        } & Record<string, unknown>;
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const { translation } = await helpCenterPut<{ translation: ZendeskTranslation }>(
          hcSubdomain,
          token,
          `/articles/${article_id}/translations/${locale}`,
          { translation: updates },
        );
        return {
          content: [
            {
              type: 'text',
              text: `Translation updated for article #${article_id} in "${locale}".\n\n${formatTranslation(translation)}`,
            },
          ],
        };
      },
    },
    {
      name: 'list_section_translations',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Section Translations',
      description:
        "List a section's translations: per locale, its name, whether a description is set, and draft or published. Use it when a section looks wrong in a locale: list_sections omits an untranslated section, and a draft may still be listed there under its name, so only this draft flag says if it is published. Fix with set_section_translation; for the whole tree, find_translation_gaps.",
      inputSchema: z.object({
        section_id: z
          .number()
          .int()
          .describe('Section id, from list_sections or zendesk-hc://topology.'),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { section_id, brand_id } = params as {
          section_id: number;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const translations = await listNodeTranslations(
          hcSubdomain,
          token,
          'sections',
          section_id,
          undefined,
        );
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                translations,
                formatNodeTranslationSummary,
                undefined,
                'list_section_translations takes only section_id, so this listing cannot be narrowed from the call; write one locale with set_section_translation.',
              ),
            },
          ],
        };
      },
    },
    {
      name: 'list_category_translations',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Category Translations',
      description:
        "List a category's translations: per locale, its name, whether a description is set, and draft or published. Use it when a category looks wrong in a locale: list_categories omits an untranslated category, and a draft may still be listed there under its name, so only this draft flag says if it is published. Fix with set_category_translation; for the whole tree, find_translation_gaps.",
      inputSchema: z.object({
        category_id: z
          .number()
          .int()
          .describe('Category id, from list_categories or zendesk-hc://topology.'),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { category_id, brand_id } = params as {
          category_id: number;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const translations = await listNodeTranslations(
          hcSubdomain,
          token,
          'categories',
          category_id,
          undefined,
        );
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                translations,
                formatNodeTranslationSummary,
                undefined,
                'list_category_translations takes only category_id, so this listing cannot be narrowed from the call; write one locale with set_category_translation.',
              ),
            },
          ],
        };
      },
    },
    {
      name: 'find_translation_gaps',
      namespace: 'help_center',
      readOnly: true,
      title: 'Find Help Center Translation Gaps',
      description:
        'Report every category and section with no translation, or only a draft, in a locale. Run it around article translation: an article published in a locale is unreachable while its section exists only in the source locale. A listing in that locale cannot show this (a draft may still be listed under its name), so the audit reads each draft flag. Two listings, up to 100 categories and 100 sections; past that only the first page of each level is audited and the report says so (narrow with category_id). Fix with set_section_translation / set_category_translation.',
      inputSchema: z.object({
        locale: z
          .string()
          .describe(
            'Locale to audit, e.g. "fr", usually a non-default active one (zendesk-hc://topology); an inactive locale is reported as a warning.',
          ),
        category_id: z
          .number()
          .int()
          .optional()
          .describe('Only this category and its sections (id from list_categories).'),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { locale, category_id, brand_id } = params as {
          locale: string;
          category_id?: number;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const [locales, categoryScope, sectionsRes] = await Promise.all([
          helpCenterGet<ZendeskLocalesResponse>(hcSubdomain, token, '/locales', undefined),
          fetchGapCategories(hcSubdomain, token, category_id),
          helpCenterGet<ZendeskListResponse<ZendeskSection>>(
            hcSubdomain,
            token,
            sectionListPath(category_id, undefined),
            { ...buildCursorParams(MAX_PAGE_SIZE, undefined), include: TRANSLATIONS_SIDELOAD },
          ),
        ]);

        const allCategories = categoryScope.categories;
        const allSections = sectionsRes.sections ?? [];
        const categories = withSideloadedTranslations(allCategories);
        const sections = withSideloadedTranslations(allSections);

        const categoryGaps = categories.flatMap(
          (category) => classifyGap(category, category.translations, locale) ?? [],
        );
        const sectionGaps = sections.flatMap(
          (section) => classifyGap(section, section.translations, locale) ?? [],
        );

        return {
          content: [
            {
              type: 'text',
              text: renderGapReport({
                locale,
                activeLocales: locales.locales ?? [],
                categoryGaps,
                sectionGaps,
                scanned: { categories: categories.length, sections: sections.length },
                found: { categories: allCategories.length, sections: allSections.length },
                listingIncomplete:
                  categoryScope.hasMore ||
                  extractPaginationMeta(sectionsRes, allSections.length).has_more,
                categoryScoped: category_id !== undefined,
              }),
            },
          ],
        };
      },
    },
    {
      name: 'set_section_translation',
      namespace: 'help_center',
      readOnly: false,
      title: 'Create or Update a Section Translation',
      description:
        "Create or update a section's translation in one locale and return it. The reply gives locale, name and draft state; no listing is needed first. Only fields you pass are written, so publishing a draft is just draft: false. Use it for the gaps find_translation_gaps reports.",
      inputSchema: z.object({
        section_id: z
          .number()
          .int()
          .describe(
            'Section id, from list_sections, find_translation_gaps or zendesk-hc://topology.',
          ),
        locale: z
          .string()
          .describe(
            'Locale to write, e.g. "fr"; must be active (zendesk-hc://topology). Existing ones: list_section_translations.',
          ),
        name: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Localized name; required for a new translation, omit to keep an existing one.',
          ),
        description: z
          .string()
          .optional()
          .describe('Localized description; an empty string clears it.'),
        draft: z
          .boolean()
          .optional()
          .describe(
            'false publishes it to end users in this locale, true makes it a draft. A new translation defaults to false; omit to keep an existing state.',
          ),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { section_id, brand_id, ...input } = params as {
          section_id: number;
          locale: string;
          name?: string;
          description?: string;
          draft?: boolean;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const { translation, created } = await upsertNodeTranslation(
          hcSubdomain,
          token,
          'sections',
          section_id,
          input,
        );
        return {
          content: [
            {
              type: 'text',
              text: nodeTranslationWriteText('sections', section_id, translation, created),
            },
          ],
        };
      },
    },
    {
      name: 'set_category_translation',
      namespace: 'help_center',
      readOnly: false,
      title: 'Create or Update a Category Translation',
      description:
        "Create or update a category's translation in one locale and return it. The reply gives locale, name and draft state; no listing is needed first. Only fields you pass are written, so publishing a draft is just draft: false. Use it for the gaps find_translation_gaps reports.",
      inputSchema: z.object({
        category_id: z
          .number()
          .int()
          .describe(
            'Category id, from list_categories, find_translation_gaps or zendesk-hc://topology.',
          ),
        locale: z
          .string()
          .describe(
            'Locale to write, e.g. "fr"; must be active (zendesk-hc://topology). Existing ones: list_category_translations.',
          ),
        name: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Localized name; required for a new translation, omit to keep an existing one.',
          ),
        description: z
          .string()
          .optional()
          .describe('Localized description; an empty string clears it.'),
        draft: z
          .boolean()
          .optional()
          .describe(
            'false publishes it to end users in this locale, true makes it a draft. A new translation defaults to false; omit to keep an existing state.',
          ),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { category_id, brand_id, ...input } = params as {
          category_id: number;
          locale: string;
          name?: string;
          description?: string;
          draft?: boolean;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const { translation, created } = await upsertNodeTranslation(
          hcSubdomain,
          token,
          'categories',
          category_id,
          input,
        );
        return {
          content: [
            {
              type: 'text',
              text: nodeTranslationWriteText('categories', category_id, translation, created),
            },
          ],
        };
      },
    },
    {
      name: 'list_permission_groups',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Permission Groups',
      description:
        "List Guide permission groups, which set who can edit and publish an article. Each has id, name and built-in flag, for create_article and update_article. Who can view: list_user_segments. Guide admins and Help Center managers only; otherwise reuse an article's permission_group_id from get_article.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (_params, { caller }) => {
        const token = await caller.getToken();
        let response: { permission_groups: ZendeskPermissionGroup[]; count: number };
        try {
          response = await zendeskGet<{
            permission_groups: ZendeskPermissionGroup[];
            count: number;
          }>(subdomain, token, '/guide/permission_groups');
        } catch (error) {
          // GET /guide/permission_groups requires Guide-admin / Help Center manager
          // rights, a tier above per-article editing. Rewrite the generic 403 into
          // guidance the LLM can act on, pointing at the content-editor fallback.
          if (error instanceof ZendeskApiError && error.status === 403) {
            throw new Error(
              'list_permission_groups reads Guide permission groups (GET /guide/permission_groups), which Zendesk restricts to Guide admins / Help Center managers. The current token lacks that role (HTTP 403). To obtain a permission_group_id without it, read an existing article with get_article and reuse its permission_group_id.',
              { cause: error },
            );
          }
          throw error;
        }
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                response.permission_groups ?? [],
                formatPermissionGroup,
                undefined,
                'list_permission_groups takes no parameters, so this listing cannot be narrowed from the call.',
              ),
            },
          ],
        };
      },
    },
    {
      name: 'create_article',
      namespace: 'help_center',
      readOnly: false,
      title: 'Create Help Center Article',
      description:
        'Create a new article in a section and return the created article with its id. To add content in other locales afterwards, use create_article_translation.',
      inputSchema: z.object({
        section_id: z.number().int().describe('Section to create it in (id from list_sections).'),
        title: z.string().min(1).describe('Article title, in its source locale.'),
        body: z.string().min(1).describe('Article body in HTML, in the source locale.'),
        permission_group_id: z
          .number()
          .int()
          .describe(
            "Who can edit (id from list_permission_groups, or an existing article's from get_article).",
          ),
        user_segment_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Who can see it, everyone by default (id from list_user_segments, or an existing article's from get_article).",
          ),
        author_id: z.number().int().optional().describe('Author user id; defaults to you.'),
        content_tag_ids: z
          .array(z.string())
          .optional()
          .describe('Content tag ids, from list_content_tags.'),
        locale: z
          .string()
          .optional()
          .describe(
            'Source locale of the article, e.g. "en-us"; defaults to the Help Center default.',
          ),
        draft: z
          .boolean()
          .default(true)
          .describe('true creates it unpublished; false publishes it now.'),
        promoted: z
          .boolean()
          .default(false)
          .describe('true features it at the top of its section.'),
        label_names: z
          .array(z.string())
          .optional()
          .describe('Search-ranking labels (existing ones: list_labels).'),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { section_id, brand_id, ...articleData } = params as {
          section_id: number;
          brand_id?: number | string;
        } & Record<string, unknown>;
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const { article } = await helpCenterPost<{ article: ZendeskArticle }>(
          hcSubdomain,
          token,
          `/sections/${section_id}/articles`,
          { article: articleData },
        );
        return {
          content: [
            { type: 'text', text: `Article #${article.id} created.\n\n${formatArticle(article)}` },
          ],
        };
      },
    },
    {
      name: 'update_article',
      namespace: 'help_center',
      readOnly: false,
      title: 'Update Help Center Article',
      description:
        'Change article metadata and return the updated article. It covers publication, promotion, labels, tags, visibility, section, position and author; omitted fields are kept. Title and body: update_article_translation, or update_article_section for one section. First or last in a section: reorder_article, since articles often share position 0. To remove an article use archive_article; draft: true only unpublishes it.',
      inputSchema: z.object({
        article_id: z.number().int().describe('Article id, from list_articles or search_articles.'),
        draft: z
          .boolean()
          .optional()
          .describe('true unpublishes (back to draft), false publishes.'),
        promoted: z.boolean().optional().describe('true features it in its section, false stops.'),
        label_names: z
          .array(z.string())
          .optional()
          .describe('Search-ranking labels (existing ones: list_labels).'),
        content_tag_ids: z
          .array(z.string())
          .optional()
          .describe('Content tag ids, from list_content_tags.'),
        user_segment_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Who can see it (id from list_user_segments, or an existing article's from get_article).",
          ),
        author_id: z.number().int().optional().describe('Author user id, from search_users.'),
        permission_group_id: z
          .number()
          .int()
          .optional()
          .describe(
            "Who can edit (id from list_permission_groups, or an existing article's from get_article).",
          ),
        section_id: z
          .number()
          .int()
          .optional()
          .describe('Section to move it to (id from list_sections).'),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Position in a manually sorted section (0 = top, where new articles land). For the end, read the highest P with list_articles(sort_by="position", sort_order="desc") and set P + 1.',
          ),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { article_id, brand_id, ...updates } = params as {
          article_id: number;
          brand_id?: number | string;
        } & Record<string, unknown>;
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const { article } = await helpCenterPut<{ article: ZendeskArticle }>(
          hcSubdomain,
          token,
          `/articles/${article_id}`,
          { article: updates },
        );
        return {
          content: [
            { type: 'text', text: `Article #${article.id} updated.\n\n${formatArticle(article)}` },
          ],
        };
      },
    },
    {
      name: 'reorder_article',
      namespace: 'help_center',
      readOnly: false,
      title: 'Reorder Help Center Article',
      description:
        'Move an article within its section (top, bottom, or before/after another) and return whether the order took. It writes the fewest positions that make the order certain, unlike a plain position write while articles tie at 0. Another section: update_article with section_id. In a section sorted automatically the writes are ignored, and the reply says to switch it to manual ordering in Guide. A move can shift neighbours, so a large one needs confirm.',
      inputSchema: z.object({
        article_id: z.number().int().describe('Article id, from list_articles or search_articles.'),
        target: z
          .enum(['top', 'bottom', 'before', 'after'])
          .describe('"top", "bottom", or "before"/"after" reference_article_id.'),
        reference_article_id: z
          .number()
          .int()
          .optional()
          .describe(
            'For "before"/"after": the other article of the same section to place it next to.',
          ),
        normalize: z
          .boolean()
          .default(false)
          .describe(
            'true also renumbers the section 0, 1, 2, …; false leaves gaps. The confirm threshold applies either way.',
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            'Pass true to allow a move that rewrites more positions than REORDER_CONFIRM_THRESHOLD (default 20); without it such a call is refused with the count. No effect on smaller moves.',
          ),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const {
          article_id,
          target,
          reference_article_id,
          normalize = false,
          confirm = false,
          brand_id,
        } = params as {
          article_id: number;
          target: ReorderTarget;
          reference_article_id?: number;
          normalize?: boolean;
          confirm?: boolean;
          brand_id?: number | string;
        };

        // Cross-field validation (the schema is a plain object; enforce the
        // target/reference relationship here, like archive_article's confirm guard).
        assertReorderParamsCoherent(article_id, target, reference_article_id);
        const needsReference = needsReferenceArticle(target);

        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);

        // Resolve the article's section (also validates the article exists).
        const { article } = await helpCenterGet<{ article: ZendeskArticle }>(
          hcSubdomain,
          token,
          `/articles/${article_id}`,
          undefined,
        );
        const sectionId = article.section_id;
        // Scope every section listing to the article's locale — the endpoint
        // rejects a locale-less request when the section's default sort is
        // locale-dependent (see fetchSectionOrder).
        const locale = article.source_locale;

        const effective = await fetchSectionOrder(sectionId, locale, token, hcSubdomain);

        // Guarding on the value, not the derived flag: after
        // assertReorderParamsCoherent the two are equivalent, and this one
        // narrows the type so the error strings cannot render `#undefined`.
        if (reference_article_id !== undefined) {
          await assertReferenceInSection(
            effective,
            reference_article_id,
            article_id,
            sectionId,
            token,
            hcSubdomain,
          );
        }

        const targetLabel = needsReference ? `${target} article #${reference_article_id}` : target;

        const desired = arrangeDesiredOrder(effective, article_id, target, reference_article_id);
        const writes = computePositionWrites(desired, article_id, normalize);

        if (writes.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Article #${article_id} is already positioned ${targetLabel} in section #${sectionId}. No changes made.`,
              },
            ],
          };
        }

        // A strict inversion proves the section ignores `position`. Short-circuit
        // before any write, at any size — writing would be ignored regardless. The
        // post-write verification backstops what an inversion cannot reveal up
        // front, such as an auto order that happens to ascend.
        if (hasPositionInversion(effective)) {
          return { content: [{ type: 'text', text: autoSortNotice(sectionId) }] };
        }

        // Blast-radius guard.
        if (writes.length > REORDER_CONFIRM_THRESHOLD && confirm !== true) {
          return {
            content: [
              {
                type: 'text',
                text: `Reordering article #${article_id} to ${targetLabel} would reposition ${writes.length} articles in section #${sectionId}, above the safety threshold of ${REORDER_CONFIRM_THRESHOLD}. Re-run with confirm: true to proceed.`,
              },
            ],
          };
        }

        const applied = await applyPositionWrites(writes, article_id, token, hcSubdomain);

        // Verify the move took effect (the definitive auto-sort check).
        const after = await fetchSectionOrder(sectionId, locale, token, hcSubdomain);
        if (!isPlacedAsRequested(after, article_id, target, reference_article_id)) {
          return { content: [{ type: 'text', text: autoSortNotice(sectionId, applied) }] };
        }

        return {
          content: [
            {
              type: 'text',
              text: `Article #${article_id} moved to ${targetLabel} in section #${sectionId} (${applied} article${applied === 1 ? '' : 's'} repositioned).`,
            },
          ],
        };
      },
    },
    {
      name: 'archive_article',
      namespace: 'help_center',
      readOnly: false,
      title: 'Archive Help Center Article',
      description:
        'Archive an article and its translations, restorable in Guide; returns a confirmation. Permanent deletion is Guide-only. To only unpublish, use update_article with draft: true. Requires confirm: true.',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        confirm: z
          .boolean()
          .describe('Must be true; anything else refuses without calling Zendesk.'),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { article_id, confirm, brand_id } = params as {
          article_id: number;
          confirm: boolean;
          brand_id?: number | string;
        };
        if (confirm !== true) {
          throw new Error(
            'Archiving is guarded: pass confirm: true to archive (soft-delete) this article. No changes were made.',
          );
        }
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        await helpCenterDelete(hcSubdomain, token, `/articles/${article_id}`);
        return {
          content: [
            {
              type: 'text',
              text: `Article #${article_id} archived (soft-deleted). It is removed from the Help Center; restore it from the Guide admin UI if needed.`,
            },
          ],
        };
      },
    },
    {
      name: 'list_content_tags',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Content Tags',
      description:
        'List content tags, the labels readers see on articles. Check name_prefix before create_content_tag to reuse a tag. Hidden search labels: list_labels.',
      inputSchema: z.object({
        name_prefix: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Only tags whose name starts with this (no fuzzy match); a full name checks if it exists.',
          ),
        sort_by: z
          .enum(['name', 'id'])
          .default('name')
          .describe('Sort field; "name" is alphabetical.'),
        sort_order: z
          .enum(['asc', 'desc'])
          .default('asc')
          .describe('Sort direction: ascending or descending.'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(CONTENT_TAGS_MAX_PAGE_SIZE)
          .default(CONTENT_TAGS_MAX_PAGE_SIZE)
          .describe('Content tags per page.'),
        cursor: z
          .string()
          .optional()
          .describe('Cursor from the previous response; omit for the first page.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { name_prefix, sort_by, sort_order, page_size, cursor } = params as {
          name_prefix?: string;
          sort_by: string;
          sort_order: string;
          page_size: number;
          cursor?: string;
        };
        const token = await caller.getToken();
        // /guide/content_tags takes a single `sort` param, `-` prefix for
        // descending; the tool surface keeps the sort_by/sort_order convention
        // shared with the sibling list tools and translates to the wire format.
        const sort = `${sort_order === 'desc' ? '-' : ''}${sort_by}`;
        const p: Record<string, string> = { ...buildCursorParams(page_size, cursor), sort };
        if (name_prefix) p['filter[name_prefix]'] = name_prefix;
        const response = await zendeskGet<ZendeskListResponse<ZendeskContentTag>>(
          subdomain,
          token,
          '/guide/content_tags',
          p,
        );
        const records = response.records ?? [];
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                records,
                formatContentTag,
                extractPaginationMeta(response, records.length),
              ),
            },
          ],
        };
      },
    },
    {
      name: 'create_content_tag',
      namespace: 'help_center',
      readOnly: false,
      title: 'Create Content Tag',
      description:
        'Create a content tag, a label readers see on articles, and return it with its id. Check list_content_tags (name_prefix) first, then attach it via content_tag_ids of create_article or update_article. Hidden search labels: list_labels.',
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe('Name shown to readers (e.g. "billing", "getting-started").'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { name } = params as { name: string };
        const token = await caller.getToken();
        const { content_tag } = await zendeskPost<{ content_tag: ZendeskContentTag }>(
          subdomain,
          token,
          '/guide/content_tags',
          { content_tag: { name } },
        );
        return {
          content: [
            { type: 'text', text: `Content tag created.\n\n${formatContentTag(content_tag)}` },
          ],
        };
      },
    },
    {
      name: 'list_labels',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Article Labels',
      description:
        'List article labels (id and name): hidden from readers, they tune search ranking. Attach them via label_names of create_article or update_article, reusing existing ones. Labels readers see: list_content_tags.',
      inputSchema: z.object({
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { brand_id } = params as { brand_id?: number | string };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const response = await helpCenterGet<{ labels: ZendeskLabel[]; count: number }>(
          hcSubdomain,
          token,
          '/articles/labels',
          undefined,
        );
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                response.labels ?? [],
                formatLabel,
                undefined,
                'list_labels takes no filter parameters, so this listing cannot be narrowed from the call.',
              ),
            },
          ],
        };
      },
    },
    {
      name: 'list_user_segments',
      namespace: 'help_center',
      readOnly: true,
      title: 'List User Segments',
      description:
        "List user segments, which set who can view an article. Each has id, name, user type and built-in flag, for user_segment_id in create_article or update_article. Who can edit: list_permission_groups. Guide admins and Help Center managers only; otherwise reuse an article's user_segment_id from get_article, or omit it on create_article for everyone.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (_params, { caller }) => {
        const token = await caller.getToken();
        // User segments are ACCOUNT-WIDE (shared across brands — the endpoint
        // has no brand dimension), so this call is deliberately NOT brand-scoped,
        // matching the topology resource's unscoped fetch.
        let response: { user_segments: ZendeskUserSegment[]; count: number };
        try {
          response = await helpCenterGet<{
            user_segments: ZendeskUserSegment[];
            count: number;
          }>(subdomain, token, '/user_segments', undefined);
        } catch (error) {
          // GET /help_center/user_segments requires Guide-admin / Help Center manager
          // rights. Rewrite the generic 403 into actionable guidance with the
          // content-editor fallback for setting article visibility.
          if (error instanceof ZendeskApiError && error.status === 403) {
            throw new Error(
              "list_user_segments reads Help Center user segments (GET /help_center/user_segments), which Zendesk restricts to Guide admins / Help Center managers. The current token lacks that role (HTTP 403). To set an article's visibility without it, reuse the user_segment_id of an existing article (get_article), or omit user_segment_id when creating/updating to default to everyone.",
              { cause: error },
            );
          }
          throw error;
        }
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                response.user_segments ?? [],
                formatUserSegment,
                undefined,
                'list_user_segments takes no parameters, so this listing cannot be narrowed from the call.',
              ),
            },
          ],
        };
      },
    },
    {
      name: 'list_article_attachments',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Article Attachments',
      description:
        "List an article's attachments, inline and block: id, file name, type, size, no bytes. Ticket files: get_ticket_attachments; uploads: create_article_attachment.",
      inputSchema: z.object({
        article_id: z.number().int().describe('Article id, from list_articles or search_articles.'),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { article_id, brand_id } = params as {
          article_id: number;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const response = await helpCenterGet<{
          article_attachments: ZendeskArticleAttachment[];
          count: number;
        }>(hcSubdomain, token, `/articles/${article_id}/attachments`);
        const attachments = response.article_attachments ?? [];
        if (attachments.length === 0) {
          return {
            content: [{ type: 'text', text: `No attachments found on article #${article_id}.` }],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: formatList(
                attachments,
                formatAttachment,
                undefined,
                'list_article_attachments takes only article_id, so this listing cannot be narrowed from the call.',
              ),
            },
          ],
        };
      },
    },
    {
      name: 'get_article_outline',
      namespace: 'help_center',
      readOnly: true,
      title: 'Get Article Outline',
      description:
        'Outline an article in one locale: its h1-h3 sections with word counts, and its translations with their outdated flag. Then read one section with get_article_section.',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        locale: z.string().optional().describe('Locale to outline; defaults to the source_locale.'),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { article_id, locale, brand_id } = params as {
          article_id: number;
          locale?: string;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const { article } = await helpCenterGet<{ article: ZendeskArticle }>(
          hcSubdomain,
          token,
          `/articles/${article_id}`,
          undefined,
        );
        const effectiveLocale = locale ?? article.source_locale;
        const { translation } = await helpCenterGet<{ translation: ZendeskTranslation }>(
          hcSubdomain,
          token,
          `/articles/${article_id}/translations/${effectiveLocale}`,
          undefined,
        );
        const translations = await listTranslations(hcSubdomain, token, article_id);
        const { parseSections } = await loadArticleFormat();
        const sections = parseSections(translation.body);

        const outlineLines = sections.length
          ? sections
              .map(
                (s) =>
                  `- [${s.index}] ${s.headingTag ? `${s.headingTag}: ` : ''}${s.heading} (${s.wordCount} words)`,
              )
              .join('\n')
          : '_(no sections detected)_';
        const translationsList = translations
          .map((t) => `- ${t.locale}${t.outdated ? ' (outdated)' : ''}`)
          .join('\n');

        const text = [
          `# Outline — Article #${article_id} (${effectiveLocale})`,
          `**Title**: ${translation.title}`,
          '',
          '## Sections',
          outlineLines,
          '',
          '## Available translations',
          translationsList,
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      },
    },
    {
      name: 'get_article_section',
      namespace: 'help_center',
      readOnly: true,
      title: 'Get Article Section',
      description:
        'Read one section of an article in a locale; get its index from get_article_outline. The leading "## [n] hN: ..." line is a label, not content.',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        locale: z.string().describe('Locale to read (e.g. "en-us", "fr").'),
        section_index: z
          .number()
          .int()
          .min(0)
          .describe(
            '0-based section index, from get_article_outline; 0 is the heading-less intro when text precedes the first heading.',
          ),
        format: z
          .enum(['html', 'markdown'])
          .default('html')
          .describe(
            '"html" round-trips safely; "markdown" is for reading only (lossy on <pre> with <br> and tables with multi-<p> cells), never to send back to update_article_section.',
          ),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { article_id, locale, section_index, format, brand_id } = params as {
          article_id: number;
          locale: string;
          section_index: number;
          format: 'html' | 'markdown';
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const { translation } = await helpCenterGet<{ translation: ZendeskTranslation }>(
          hcSubdomain,
          token,
          `/articles/${article_id}/translations/${locale}`,
          undefined,
        );
        const { htmlToMarkdown, parseSections } = await loadArticleFormat();
        const sections = parseSections(translation.body);
        const section = sections[section_index];
        if (!section) {
          throw new Error(
            `Section index ${section_index} not found. Article has ${sections.length} section(s) (0-${Math.max(0, sections.length - 1)}).`,
          );
        }
        const content = format === 'markdown' ? htmlToMarkdown(section.html) : section.html;
        const headerLine = section.headingTag
          ? `## [${section.index}] ${section.headingTag}: ${section.heading}`
          : `## [${section.index}] ${section.heading}`;
        const text = [
          headerLine,
          `_Locale: ${locale} | Words: ${section.wordCount} | Format: ${format}_`,
          '',
          content,
        ].join('\n');
        // No pagination here either, and there is nothing narrower than a
        // section — but the Markdown rendering of the same content is smaller.
        const advice =
          format === 'markdown'
            ? 'get_article_section takes no pagination parameter, and this single section already exceeds the limit.'
            : 'get_article_section takes no pagination parameter; request this section as format="markdown", which renders the same content more compactly than HTML.';
        return { content: [{ type: 'text', text: truncateIfNeeded(text, advice) }] };
      },
    },
    {
      name: 'update_article_section',
      namespace: 'help_center',
      readOnly: false,
      title: 'Update Article Section',
      description:
        'Replace one section of an article in a locale, heading excluded, keeping the rest of the article. A leading heading repeating the section heading is dropped; any other h1-h3 creates sections and shifts later indexes (the reply warns).',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        locale: z.string().describe('Locale of the translation to edit.'),
        section_index: z
          .number()
          .int()
          .min(0)
          .describe(
            '0-based index from get_article_outline; 0 is the heading-less intro when text precedes the first heading.',
          ),
        content: z
          .string()
          .describe(
            'New section content, heading excluded (and without the "## [n] hN: ..." label line). HTML, or Markdown with format="markdown".',
          ),
        format: z
          .enum(['html', 'markdown'])
          .default('html')
          .describe(
            '"html" is safe; "markdown" is converted and can leave artifacts, so avoid it for code blocks with line breaks or tables with multi-paragraph cells.',
          ),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { article_id, locale, section_index, content, format, brand_id } = params as {
          article_id: number;
          locale: string;
          section_index: number;
          content: string;
          format: 'html' | 'markdown';
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const { translation } = await helpCenterGet<{ translation: ZendeskTranslation }>(
          hcSubdomain,
          token,
          `/articles/${article_id}/translations/${locale}`,
          undefined,
        );
        const { applySectionUpdate, markdownToHtml, parseSections } = await loadArticleFormat();
        const newSectionHtml = format === 'markdown' ? markdownToHtml(content) : content;
        const {
          body: newBody,
          stripped,
          contentHeadings,
          introLost,
          sectionsBefore,
        } = applySectionUpdate(translation.body, section_index, newSectionHtml);
        const { translation: updated } = await helpCenterPut<{ translation: ZendeskTranslation }>(
          hcSubdomain,
          token,
          `/articles/${article_id}/translations/${locale}`,
          { translation: { body: newBody } },
        );
        const updatedSections = parseSections(updated.body);
        const updatedSection = updatedSections[section_index];
        // An emptied intro leaves nothing at [n]: the section now there is a later one.
        const emptied = introLost === 'empty';
        const newWordCount = emptied ? 0 : (updatedSection?.wordCount ?? 0);
        const headingLabel = emptied ? '(intro)' : (updatedSection?.heading ?? '(intro)');
        const text = [
          `Section [${section_index}] "${headingLabel}" updated for article #${article_id} (${locale}).`,
          `New word count: ${newWordCount}.`,
          ...sectionUpdateNotes({
            stripped,
            contentHeadings,
            introLost,
            sectionIndex: section_index,
            sectionsBefore,
            sectionsAfter: updatedSections.length,
          }),
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      },
    },
    {
      name: 'compare_translations',
      namespace: 'help_center',
      readOnly: true,
      title: 'Compare Article Translations',
      description:
        'Compare two locales of an article to see whether the target translation needs work, as separate signals. Freshness (main signal): a source updated after the target is "likely behind" with the day gap. Zendesk\'s "outdated" flag: set only by Guide\'s "mark out of date", so "no" proves nothing. A structure check warns when sections may be misaligned; a per-section table marks each "ok", "missing" or "extra". Word counts are informational: languages differ in length. Three GET calls.',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        source_locale: z
          .string()
          .describe('Reference locale, e.g. "en-us", usually the source_locale.'),
        target_locale: z.string().describe('Locale of the translation to check.'),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { article_id, source_locale, target_locale, brand_id } = params as {
          article_id: number;
          source_locale: string;
          target_locale: string;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const [sourceRes, targetRes, translations] = await Promise.all([
          helpCenterGet<{ translation: ZendeskTranslation }>(
            hcSubdomain,
            token,
            `/articles/${article_id}/translations/${source_locale}`,
            undefined,
          ),
          helpCenterGet<{ translation: ZendeskTranslation }>(
            hcSubdomain,
            token,
            `/articles/${article_id}/translations/${target_locale}`,
            undefined,
          ),
          // The `outdated` flag is only exposed on the list endpoint, not on a
          // single-translation GET — same reason get_article_outline lists too.
          listTranslations(hcSubdomain, token, article_id),
        ]);
        const { parseSections } = await loadArticleFormat();
        const sourceSections = parseSections(sourceRes.translation.body);
        const targetSections = parseSections(targetRes.translation.body);

        const freshnessLine = renderFreshnessLine(
          sourceRes.translation.updated_at,
          targetRes.translation.updated_at,
          target_locale,
        );
        const outdatedLine = renderOutdatedLine(translations, target_locale);
        const structureLine = renderStructureLine(sourceSections, targetSections);
        const rows = renderSectionRows(sourceSections, targetSections);

        const text = [
          `# Translation diff — Article #${article_id} (${source_locale} → ${target_locale})`,
          '',
          freshnessLine,
          outdatedLine,
          structureLine,
          `- **Updated**: source ${sourceRes.translation.updated_at} | target ${targetRes.translation.updated_at}`,
          `- **Target draft**: ${targetRes.translation.draft ? 'yes' : 'no'}`,
          '',
          '_Word counts are informational: a length difference between languages is normal, not a divergence._',
          '',
          ...rows,
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      },
    },
    {
      name: 'create_article_attachment',
      namespace: 'help_center',
      readOnly: false,
      title: 'Create Article Attachment',
      description:
        'Upload a file to an article and return the created attachment (id, name, type, size). A second call adds another copy. Existing ones: list_article_attachments; ticket files: get_ticket_attachments.',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        file_name: z
          .string()
          .min(1)
          .describe('File name with extension (e.g. "screenshot.png"), used for download.'),
        file_base64: z
          .string()
          .min(1)
          // `abort` stops the chain here, so the base64 regex does not scan
          // megabytes already disqualified by their length. In-range inputs and
          // the published schema are unaffected.
          .max(MAX_BASE64_INPUT_CHARS, {
            abort: true,
            error: (issue) =>
              `File too large: ${(issue.input as string).length} base64 characters, limit ${MAX_BASE64_INPUT_CHARS}. Downscale the file, split it, or host it elsewhere and link to it.`,
          })
          .describe(
            `The file's raw bytes, base64-encoded; the server decodes them before upload. The length cap is about ${MAX_BASE64_INPUT_MB} MB of file; the HTTP transport also caps request bodies at 4 MB.`,
          ),
        content_type: z
          .string()
          .default('application/octet-stream')
          .describe('MIME type, e.g. "image/png".'),
        ...brandIdPart,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params, { caller }) => {
        const { article_id, file_name, file_base64, content_type, brand_id } = params as {
          article_id: number;
          file_name: string;
          file_base64: string;
          content_type: string;
          brand_id?: number | string;
        };
        const token = await caller.getToken();
        const hcSubdomain = await resolveHcSubdomain(caller, brand_id);
        const buffer = Buffer.from(file_base64, 'base64');
        const blob = new Blob([buffer], { type: content_type });
        const formData = new FormData();
        formData.append('file', blob, file_name);
        const { article_attachment } = await helpCenterUpload<{
          article_attachment: ZendeskArticleAttachment;
        }>(hcSubdomain, token, `/articles/${article_id}/attachments`, formData);
        return {
          content: [
            {
              type: 'text',
              text: `Attachment created for article #${article_id}.\n\n${formatAttachment(article_attachment)}`,
            },
          ],
        };
      },
    },
  ];
};
