import * as z from 'zod/v4';
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
  MAX_PAGE_SIZE,
  REORDER_CONFIRM_THRESHOLD,
  TRANSLATION_GAP_SCAN_MAX_NODES,
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
import {
  arrangeDesiredOrder,
  computePositionWrites,
  hasPositionInversion,
  isPlacedAsRequested,
  type OrderedArticle,
  type ReorderTarget,
  type ReorderWrite,
} from '../utils/article-order';
import {
  htmlToMarkdown,
  markdownToHtml,
  parseSections,
  replaceSectionContent,
  type Section,
} from '../utils/article-sections';
import {
  formatArticle,
  formatArticleSummary,
  formatAttachment,
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
import type { ToolContext, ToolDefinition } from './definitions';

// Byte-identical across the seven read/section/attachment tools that take an
// article id. Kept as one constant (like PER_PAGE_DESC/PAGE_DESC) so the "how to
// obtain it" guidance can't drift between copies. The two article-write tools
// use their own variant ("...to update" / "...whose translation to update").
const ARTICLE_ID_DESC =
  'Article ID — the numeric id of the Help Center article. Obtain it from list_articles or search_articles.';

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
// Sections and categories live on the same Translations endpoint family as
// articles (`/{sections|categories}/{id}/translations`) and return the same
// translation object, with two fields carrying different meanings: `title` is the
// localized *name* and `body` the localized *description*. The tools speak
// name/description — the vocabulary list_sections and list_categories already
// return — and do the mapping here, so a caller never has to know about it.
type TreeNodeKind = 'sections' | 'categories';

const NODE_LABEL: Record<TreeNodeKind, string> = {
  sections: 'section',
  categories: 'category',
};

// `locales` narrows the response when the caller only cares about one language.
// The result is filtered locally anyway (see findTranslation), so the tools stay
// correct even where the server-side filter is not applied. The value is
// lower-cased so the server-side filter cannot disagree with that local,
// case-insensitive comparison: Zendesk stores locales lower-cased, and whether it
// matches the filter case-sensitively is not documented — if it does, a caller's
// "FR" would come back empty and every node would read as "no translation".
// Normalizing costs nothing if the filter is case-insensitive after all.
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

// Locales are matched case-insensitively: Zendesk normalizes its own to lower
// case, but a caller (or a copy-paste from Guide) may well pass "fr-FR".
const findTranslation = (
  translations: ZendeskTranslation[],
  locale: string,
): ZendeskTranslation | undefined => {
  const wanted = locale.toLowerCase();
  return translations.find((t) => t.locale.toLowerCase() === wanted);
};

/**
 * Create-or-update a section/category translation in one call.
 *
 * The probe that decides POST vs PUT is the very call `list_*_translations`
 * makes, so the caller pays one request instead of being forced to list first —
 * or to recover from the 400 the API returns when a POST targets a locale that
 * already has a translation. Only the fields actually passed are sent on update,
 * so omitting `description` never blanks an existing one and omitting `draft`
 * never republishes (or unpublishes) by accident.
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
  // An empty payload would round-trip to Zendesk and come back reported as an
  // update, which is a lie. Say what is missing instead.
  if (Object.keys(updates).length === 0) {
    throw new Error(
      `Nothing to write: ${NODE_LABEL[kind]} #${nodeId} already has a "${existing.locale}" translation, so pass at least one of "name", "description" or "draft" to change it (draft: false publishes it).`,
    );
  }
  // Zendesk's own spelling of the locale, not the caller's: the PUT path has to
  // match the existing translation even when the input was cased differently.
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
// A node is a gap when the target locale has no translation at all, or has one
// that is still a draft. Those need different fixes (write a translation vs flip
// `draft`), which is exactly what `list_sections?locale=…` cannot tell you: it
// omits both cases alike.
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
  scanned: { categories: number; sections: number };
  found: { categories: number; sections: number };
  /** True when the category or section listing itself spilled past one page. */
  listingIncomplete: boolean;
}

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
  // "every one scanned has a translation" would be a wrong reading of an empty
  // scan (a category with no sections, a scope that matched nothing) — and
  // "nothing to scan" would be a wrong reading of a level the node cap never
  // reached, which is the opposite of an all-clear.
  if (scanned === 0) {
    return [
      header,
      found === 0
        ? '_(none to scan at this level)_'
        : `_(none scanned — the ${TRANSLATION_GAP_SCAN_MAX_NODES}-node cap was spent before this level; ${found} left unchecked, see the note below)_`,
    ];
  }
  return [header, '_(none — every one scanned has a published translation)_'];
};

// Nodes probed at a time. Zendesk enforces a per-account *concurrent* request
// limit well below the node cap, and a single 429 rejects the whole audit, so the
// scan goes in small waves instead of firing every node at once. Same requests,
// same report — just a bounded burst.
const GAP_SCAN_WAVE_SIZE = 5;

const probeInWaves = async <T>(
  nodes: T[],
  probe: (node: T) => Promise<TranslationGap | null>,
): Promise<TranslationGap[]> => {
  const gaps: TranslationGap[] = [];
  for (let i = 0; i < nodes.length; i += GAP_SCAN_WAVE_SIZE) {
    const wave = await Promise.all(nodes.slice(i, i + GAP_SCAN_WAVE_SIZE).map(probe));
    for (const gap of wave) {
      if (gap !== null) gaps.push(gap);
    }
  }
  return gaps;
};

// The categories to audit. Scoping to one fetches that category on its own
// rather than filtering the paginated listing: the listing is capped at one page,
// so filtering it would silently report "0 categories scanned" for a category
// that merely sits further down — and a wrong id would look like an empty tree
// instead of the 404 it is.
const fetchGapCategories = async (
  subdomain: string,
  token: string,
  categoryId: number | undefined,
): Promise<{ categories: ZendeskCategory[]; hasMore: boolean }> => {
  if (categoryId !== undefined) {
    const { category } = await helpCenterGet<{ category: ZendeskCategory }>(
      subdomain,
      token,
      `/categories/${categoryId}`,
    );
    return { categories: [category], hasMore: false };
  }
  const response = await helpCenterGet<ZendeskListResponse<ZendeskCategory>>(
    subdomain,
    token,
    '/categories',
    buildCursorParams(MAX_PAGE_SIZE, undefined),
  );
  const categories = response.categories ?? [];
  return { categories, hasMore: extractPaginationMeta(response, categories.length).has_more };
};

const renderGapReport = (report: GapReport): string => {
  const { locale, categoryGaps, sectionGaps, scanned, found } = report;
  const gapCount = categoryGaps.length + sectionGaps.length;
  const capped = scanned.categories < found.categories || scanned.sections < found.sections;
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
      gapCount === 0
        ? `No gaps: all ${scanned.categories} category/ies and ${scanned.sections} section(s) scanned have a published "${locale}" translation.`
        : `${gapCount} node(s) need a published "${locale}" translation. Fix a category with set_category_translation and a section with set_section_translation, passing draft: false to publish.`,
      ...(capped
        ? [
            '',
            `_Note: the scan stopped at its ${TRANSLATION_GAP_SCAN_MAX_NODES}-node cap, covering ${scanned.categories}/${found.categories} categories and ${scanned.sections}/${found.sections} sections. The rest were not checked — narrow the scan with category_id, or raise ZENDESK_TRANSLATION_GAP_SCAN_MAX_NODES._`,
          ]
        : []),
      ...(report.listingIncomplete
        ? [
            '',
            `_Note: this Help Center has more than ${MAX_PAGE_SIZE} categories or sections, so only the first page of each was considered. Narrow the scan with category_id to audit the rest._`,
          ]
        : []),
    ].join('\n'),
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

// Message returned when a reorder's position writes are (or would be) silently
// ignored because the section is sorted automatically rather than manually. There
// is no API field exposing the sort mode, so we name the section and the exact UI
// steps rather than fabricate an admin deep-link (none is stable across Guide
// versions). `applied` is set only after writes were attempted (post-verify path).
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

// Primary staleness signal, derived from the edit timestamps. If the source was
// edited after the target, the translation is very likely behind. Always
// available and, for API/external translation workflows, far more useful than
// Zendesk's `outdated` flag (see below). updated_at values are ISO-8601 UTC, so
// a lexical compare is order-correct; parse for the day delta.
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

// Secondary signal: Zendesk's own per-translation `outdated` flag for the target
// locale. It is only set through Guide's native "mark translations out of date"
// workflow, NOT by API edits — so for API/external workflows it usually stays
// false regardless of real staleness. Surfaced as an overlay to the freshness
// signal, never as the sole verdict. Matched case-insensitively: Zendesk accepts
// a mixed-case locale in the request URL but the list endpoint reports it
// canonically lowercased, so an exact match would spuriously report "unknown".
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
    return `\n\n_Note: the scan hit its ${ARTICLE_RESOURCES_SCAN_MAX_PAGES}-page cap (${cost}), so promoted articles deeper in the catalog may be missing. This call is costly on this Help Center — avoid repeating it; raise ZENDESK_ARTICLE_RESOURCES_SCAN_MAX_PAGES to widen coverage._`;
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

export const createHelpCenterTools = (ctx: ToolContext): ToolDefinition[] => {
  const { subdomain, getToken } = ctx;

  // Fetch a section's articles in their EFFECTIVE display order (no sort_by), the
  // order an end user sees. Fully paginated so reorder decisions and verification
  // see every article, not just the first page. Used by reorder_article.
  //
  // The listing MUST be locale-scoped: without sort_by the endpoint falls back to
  // the section's configured "Order articles by", and a locale-dependent mode
  // (title / recent activity / edited_at) makes the non-locale endpoint reject the
  // request with HTTP 400 ("must specify a locale in order to sort by title…").
  // Scoping by the article's locale both satisfies that requirement and still
  // surfaces the auto-sorted order so the inversion probe can detect it.
  const fetchSectionOrder = async (
    sectionId: number,
    locale: string,
    token: string,
  ): Promise<OrderedArticle[]> => {
    const order: OrderedArticle[] = [];
    let cursor: string | undefined;
    do {
      const response = await helpCenterGet<ZendeskListResponse<ZendeskArticle>>(
        subdomain,
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
  ): Promise<void> => {
    if (effective.some((a) => a.id === referenceArticleId)) return;

    let detail = 'was not found';
    try {
      const { article: ref } = await helpCenterGet<{ article: ZendeskArticle }>(
        subdomain,
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
  ): Promise<number> => {
    let applied = 0;
    for (const write of writes) {
      try {
        await helpCenterPut(subdomain, token, `/articles/${write.id}`, {
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
    {
      name: 'search_articles',
      namespace: 'help_center',
      readOnly: true,
      title: 'Search Help Center Articles',
      description:
        'Full-text search across Help Center articles (metadata only, no body). Use get_article for full content. Supports locale filtering. Returns total count.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'Full-text query matched against article titles and body. Plain keywords; combine with the locale filter to scope to one language.',
          ),
        locale: z.string().optional().describe('Filter by locale (e.g., "en-us", "fr")'),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe(PER_PAGE_DESC),
        page: z.number().int().min(1).default(1).describe(PAGE_DESC),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { query, locale, per_page, page } = params as {
          query: string;
          locale?: string;
          per_page: number;
          page: number;
        };
        const token = await getToken();
        const p: Record<string, string> = { query, ...buildOffsetParams(per_page, page) };
        if (locale) p['locale'] = locale;
        const response = await helpCenterGet<ZendeskListResponse<ZendeskArticle>>(
          subdomain,
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
        'Retrieve an article by ID with full body content. For large articles, prefer get_article_outline + get_article_section to save tokens. Optionally specify locale for a translated version. Returns body (HTML), metadata, source_locale, and list of available translations.',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        locale: z.string().optional().describe('Locale for translated version'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, locale } = params as { article_id: number; locale?: string };
        const token = await getToken();
        const path = locale ? `/${locale}/articles/${article_id}` : `/articles/${article_id}`;
        const { article } = await helpCenterGet<{ article: ZendeskArticle }>(
          subdomain,
          token,
          path,
        );
        const translations = await listTranslations(subdomain, token, article_id);
        const hint = largeArticleHint(article.body, parseSections(article.body).length);
        const text =
          (hint ?? '') +
          formatArticle(article) +
          `\n\n**Available translations**: ${translations.map((t) => t.locale).join(', ')}`;
        return { content: [{ type: 'text', text: truncateIfNeeded(text) }] };
      },
    },
    {
      name: 'list_categories',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Help Center Categories',
      description:
        'List all Help Center categories. Categories are the top level of the Guide hierarchy (category → section → article); each entry includes its id, name and locale. Results are cursor-paginated. Pair a returned category id with list_sections to drill down, then list_articles to reach articles. Pass a locale to read category names in that translation.',
      inputSchema: z.object({
        locale: z
          .string()
          .optional()
          .describe(
            'Locale for category names (e.g., "en-us", "fr"). Defaults to the Help Center default locale.',
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Categories per page (1-100, default 100).'),
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor from a previous response; omit for the first page.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { locale, page_size, cursor } = params as {
          locale?: string;
          page_size: number;
          cursor?: string;
        };
        const token = await getToken();
        const path = `${localePrefix(locale)}/categories`;
        const response = await helpCenterGet<ZendeskListResponse<ZendeskCategory>>(
          subdomain,
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
        "List Help Center sections. Sections are the middle level of the Guide hierarchy (category → section → article) and group related articles; each entry includes its id, name, category_id and locale. Results are cursor-paginated. Pass category_id to list only one category's sections (ids come from list_categories), then use a section id with list_articles. Pass a locale to read section names in that translation.",
      inputSchema: z.object({
        category_id: z
          .number()
          .int()
          .optional()
          .describe(
            'Restrict to sections of this category (id from list_categories). Omit to list every section.',
          ),
        locale: z
          .string()
          .optional()
          .describe(
            'Locale for section names (e.g., "en-us", "fr"). Defaults to the Help Center default locale.',
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Sections per page (1-100, default 100).'),
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor from a previous response; omit for the first page.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { category_id, locale, page_size, cursor } = params as {
          category_id?: number;
          locale?: string;
          page_size: number;
          cursor?: string;
        };
        const token = await getToken();
        const response = await helpCenterGet<ZendeskListResponse<ZendeskSection>>(
          subdomain,
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
        'List articles (metadata only, no body). Use get_article for full content. Optionally filter by section ID and locale. Supports sort_by ("title", "created_at", "updated_at") and include_translations: true to show available translation locales per article. Note: include_translations must be re-sent on each paginated request.',
      inputSchema: z.object({
        section_id: z
          .number()
          .int()
          .optional()
          .describe(
            'Restrict the listing to one section (numeric id from list_sections). Omit to list articles across all sections.',
          ),
        locale: z
          .string()
          .optional()
          .describe(
            'Restrict to a single locale, e.g. "en-us" or "fr". Omit for the default locale.',
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE)
          .describe('Articles per page (1-100, default 100).'),
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor from a previous response; omit for the first page.'),
        sort_by: z
          .enum(['created_at', 'updated_at', 'position', 'title'])
          .default('position')
          .describe('Field to sort by; "position" (the default) is the manual order set in Guide.'),
        sort_order: z
          .enum(['asc', 'desc'])
          .default('asc')
          .describe('Sort direction: ascending or descending.'),
        include_translations: z
          .boolean()
          .default(false)
          .describe(
            'Include available translation locales per article (causes 1 extra API call per article)',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { section_id, locale, page_size, cursor, sort_by, sort_order, include_translations } =
          params as {
            section_id?: number;
            locale?: string;
            page_size: number;
            cursor?: string;
            sort_by: string;
            sort_order: string;
            include_translations: boolean;
          };
        const token = await getToken();
        const response = await helpCenterGet<ZendeskListResponse<ZendeskArticle>>(
          subdomain,
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
            const translations = await listTranslations(subdomain, token, article.id);
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
        'List the promoted ("featured") Help Center articles — the small, editorially-curated set surfaced at the top of their sections. Returns metadata only (no body); use get_article for full content. COST: the Help Center API has no server-side promoted filter, so this scans article pages (one Zendesk API request per page, up to ZENDESK_ARTICLE_RESOURCES_SCAN_MAX_PAGES, default 20) and filters client-side — potentially costly on a large Help Center. Each call performs a fresh, uncached scan, so avoid calling it repeatedly. On a very large Help Center some promoted articles may be omitted, and both the omission and the number of pages scanned are flagged in the output. Lists the default locale. To promote or unpromote an article, use update_article with `promoted` (requires Help Center admin / Guide admin rights).',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async () => {
        const token = await getToken();
        const { articles, truncated, pagesScanned } = await fetchPromotedArticles(subdomain, token);
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
          content: [{ type: 'text', text: truncateIfNeeded(`${header}\n\n${body}${note}`) }],
        };
      },
    },
    {
      name: 'list_article_translations',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Article Translations',
      description:
        'List all available translations for an article (metadata only, no body: locale, title, draft, updated_at). Use get_article with locale for full translated content.',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id } = params as { article_id: number };
        const token = await getToken();
        const translations = await listTranslations(subdomain, token, article_id);
        return {
          content: [{ type: 'text', text: formatList(translations, formatTranslationSummary) }],
        };
      },
    },
    {
      name: 'create_article_translation',
      namespace: 'help_center',
      readOnly: false,
      title: 'Create Article Translation',
      description:
        'Create a translation for an existing article in a specific locale. The article must already exist (create it with create_article); this adds a new localized version and returns the created translation (locale, title, draft state). The target locale must not already have a translation — use update_article_translation to modify an existing one, and list_article_translations to see which locales exist. Provide the full HTML body.',
      inputSchema: z.object({
        article_id: z.number().int().describe('ID of the existing article to translate.'),
        locale: z.string().describe('Target locale (e.g., "fr", "de")'),
        title: z.string().min(1).describe('Translated article title.'),
        body: z.string().min(1).describe('Translated body (HTML)'),
        draft: z
          .boolean()
          .default(false)
          .describe(
            'Create the translation as a draft (not visible to end users). Defaults to false (published).',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, locale, title, body, draft } = params as {
          article_id: number;
          locale: string;
          title: string;
          body: string;
          draft: boolean;
        };
        const token = await getToken();
        const { translation } = await helpCenterPost<{ translation: ZendeskTranslation }>(
          subdomain,
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
        "Update article content (title, body) in a specific locale. For targeted edits on one or a few sections, prefer update_article_section — this tool replaces the FULL body and re-sends the entire article on each write. Use the article's source_locale (from get_article) for the default language, or another locale for translations.",
      inputSchema: z.object({
        article_id: z
          .number()
          .int()
          .describe(
            'Article ID — the numeric id of the article whose translation to update. Obtain it from list_articles or search_articles.',
          ),
        locale: z
          .string()
          .describe(
            'Locale of the translation to update, e.g. "en-us" or "fr". Use the source_locale (from get_article) to edit the default language.',
          ),
        title: z
          .string()
          .optional()
          .describe('New title for this locale. Omit to leave the current title unchanged.'),
        body: z
          .string()
          .optional()
          .describe(
            'New full body (HTML) for this locale. Replaces the entire body — for a single-section edit prefer update_article_section. Omit to leave the body unchanged.',
          ),
        draft: z
          .boolean()
          .optional()
          .describe('When true, keeps this translation as a draft; when false, publishes it.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, locale, ...updates } = params as {
          article_id: number;
          locale: string;
        } & Record<string, unknown>;
        const token = await getToken();
        const { translation } = await helpCenterPut<{ translation: ZendeskTranslation }>(
          subdomain,
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
        'List the translations of a Help Center section: for each locale, the localized name, whether a description is set, and whether the translation is published or still a draft. Reach for this when a section looks untranslated in a locale — list_sections with a locale omits a section that has no translation AND one whose translation is an unpublished draft, and only this tool tells the two apart. Fix either case with set_section_translation; to sweep every category and section at once, use find_translation_gaps.',
      inputSchema: z.object({
        section_id: z
          .number()
          .int()
          .describe(
            'Section ID — the numeric id of the Help Center section. Obtain it from list_sections or the zendesk-hc://topology resource.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { section_id } = params as { section_id: number };
        const token = await getToken();
        const translations = await listNodeTranslations(subdomain, token, 'sections', section_id);
        return {
          content: [{ type: 'text', text: formatList(translations, formatNodeTranslationSummary) }],
        };
      },
    },
    {
      name: 'list_category_translations',
      namespace: 'help_center',
      readOnly: true,
      title: 'List Category Translations',
      description:
        'List the translations of a Help Center category: for each locale, the localized name, whether a description is set, and whether the translation is published or still a draft. Reach for this when a category looks untranslated in a locale — list_categories with a locale omits a category that has no translation AND one whose translation is an unpublished draft, and only this tool tells the two apart. Fix either case with set_category_translation; to sweep every category and section at once, use find_translation_gaps.',
      inputSchema: z.object({
        category_id: z
          .number()
          .int()
          .describe(
            'Category ID — the numeric id of the Help Center category. Obtain it from list_categories or the zendesk-hc://topology resource.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { category_id } = params as { category_id: number };
        const token = await getToken();
        const translations = await listNodeTranslations(
          subdomain,
          token,
          'categories',
          category_id,
        );
        return {
          content: [{ type: 'text', text: formatList(translations, formatNodeTranslationSummary) }],
        };
      },
    },
    {
      name: 'find_translation_gaps',
      namespace: 'help_center',
      readOnly: true,
      title: 'Find Help Center Translation Gaps',
      description:
        'Audit the Help Center tree for a target locale and report every category and section that has no translation, or one that is still an unpublished draft. Use it before or after translating articles: an article published in a second locale is unreachable while its parent section only exists in the source locale, and that gap is invisible to list_sections. Costs one extra request per node scanned, capped (the report says so when the cap bites) — pass category_id to narrow it. Fix what it reports with set_section_translation / set_category_translation.',
      inputSchema: z.object({
        locale: z
          .string()
          .describe(
            'Locale to audit, e.g. "fr" or "de" — usually a non-default active locale of the Help Center (zendesk-hc://topology lists them). A locale that is not active is reported as a warning, since every node would then look untranslated.',
          ),
        category_id: z
          .number()
          .int()
          .optional()
          .describe(
            'Restrict the audit to this category and the sections it contains (id from list_categories). Omit to sweep the whole tree, which costs one request per category and per section.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { locale, category_id } = params as { locale: string; category_id?: number };
        const token = await getToken();
        const [locales, categoryScope, sectionsRes] = await Promise.all([
          helpCenterGet<ZendeskLocalesResponse>(subdomain, token, '/locales'),
          fetchGapCategories(subdomain, token, category_id),
          helpCenterGet<ZendeskListResponse<ZendeskSection>>(
            subdomain,
            token,
            sectionListPath(category_id, undefined),
            buildCursorParams(MAX_PAGE_SIZE, undefined),
          ),
        ]);

        const allCategories = categoryScope.categories;
        const allSections = sectionsRes.sections ?? [];

        // Categories first, sections with whatever budget is left: a caller
        // auditing a bilingual tree cares most about the top of it, and the note
        // in the report names exactly what went unscanned.
        const categories = allCategories.slice(0, TRANSLATION_GAP_SCAN_MAX_NODES);
        const sections = allSections.slice(
          0,
          Math.max(0, TRANSLATION_GAP_SCAN_MAX_NODES - categories.length),
        );

        const categoryGaps = await probeInWaves(categories, async (category) =>
          classifyGap(
            category,
            await listNodeTranslations(subdomain, token, 'categories', category.id, locale),
            locale,
          ),
        );
        const sectionGaps = await probeInWaves(sections, async (section) =>
          classifyGap(
            section,
            await listNodeTranslations(subdomain, token, 'sections', section.id, locale),
            locale,
          ),
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
        'Create or update the translation of a Help Center section in one locale, and return the resulting translation (locale, localized name, draft state). Creates the translation when the locale has none and updates it otherwise, so no listing call is needed first; only the fields you pass are written, which makes "publish this draft" a single draft: false. Use it to make a section reachable in a locale where its articles are already translated — a gap find_translation_gaps reports and list_sections cannot explain.',
      inputSchema: z.object({
        section_id: z
          .number()
          .int()
          .describe(
            'Section ID — the numeric id of the section whose translation to write. Obtain it from list_sections, find_translation_gaps or the zendesk-hc://topology resource.',
          ),
        locale: z
          .string()
          .describe(
            'Locale to write, e.g. "fr" or "de". Must be an active locale of the Help Center (zendesk-hc://topology lists them); list_section_translations shows which ones the section already has.',
          ),
        name: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Localized section name for this locale (sent as the API's translation `title`). Required when the locale has no translation yet; omit on an existing one to leave its name untouched, for instance when only publishing a draft.",
          ),
        description: z
          .string()
          .optional()
          .describe(
            "Localized section description for this locale (sent as the API's translation `body`). Omit to leave an existing description untouched; pass an empty string to clear it.",
          ),
        draft: z
          .boolean()
          .optional()
          .describe(
            'Publication state: false publishes the translation, making the section visible to end users in this locale; true keeps (or puts) it back as a draft. Defaults to false when creating; omit on an existing translation to leave its state unchanged.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { section_id, ...input } = params as {
          section_id: number;
          locale: string;
          name?: string;
          description?: string;
          draft?: boolean;
        };
        const token = await getToken();
        const { translation, created } = await upsertNodeTranslation(
          subdomain,
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
        'Create or update the translation of a Help Center category in one locale, and return the resulting translation (locale, localized name, draft state). Creates the translation when the locale has none and updates it otherwise, so no listing call is needed first; only the fields you pass are written, which makes "publish this draft" a single draft: false. Use it to make a category reachable in a locale where its sections or articles are already translated — a gap find_translation_gaps reports and list_categories cannot explain.',
      inputSchema: z.object({
        category_id: z
          .number()
          .int()
          .describe(
            'Category ID — the numeric id of the category whose translation to write. Obtain it from list_categories, find_translation_gaps or the zendesk-hc://topology resource.',
          ),
        locale: z
          .string()
          .describe(
            'Locale to write, e.g. "fr" or "de". Must be an active locale of the Help Center (zendesk-hc://topology lists them); list_category_translations shows which ones the category already has.',
          ),
        name: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Localized category name for this locale (sent as the API's translation `title`). Required when the locale has no translation yet; omit on an existing one to leave its name untouched, for instance when only publishing a draft.",
          ),
        description: z
          .string()
          .optional()
          .describe(
            "Localized category description for this locale (sent as the API's translation `body`). Omit to leave an existing description untouched; pass an empty string to clear it.",
          ),
        draft: z
          .boolean()
          .optional()
          .describe(
            'Publication state: false publishes the translation, making the category visible to end users in this locale; true keeps (or puts) it back as a draft. Defaults to false when creating; omit on an existing translation to leave its state unchanged.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { category_id, ...input } = params as {
          category_id: number;
          locale: string;
          name?: string;
          description?: string;
          draft?: boolean;
        };
        const token = await getToken();
        const { translation, created } = await upsertNodeTranslation(
          subdomain,
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
        'List all Guide permission groups. Use this to find the permission_group_id required when creating articles.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async () => {
        const token = await getToken();
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
              text: formatList(response.permission_groups ?? [], formatPermissionGroup),
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
        "Create a new article in a section and return the created article with its id. The locale becomes the article's source_locale. Requires a permission_group_id (use list_permission_groups to find available IDs). To add content in other locales afterwards, use create_article_translation.",
      inputSchema: z.object({
        section_id: z
          .number()
          .int()
          .describe('Section that will contain the article (numeric id from list_sections).'),
        title: z.string().min(1).describe('Title of the new article, in its source locale.'),
        body: z
          .string()
          .min(1)
          .describe('Article body as HTML (this becomes the source-locale content).'),
        permission_group_id: z
          .number()
          .int()
          .describe(
            'Permission group ID (use list_permission_groups to find it; if that is forbidden because the token is not a Guide admin, reuse the permission_group_id of an existing article from get_article).',
          ),
        user_segment_id: z
          .number()
          .int()
          .optional()
          .describe(
            'User segment ID for visibility (use list_user_segments to find it; if that is forbidden because the token is not a Guide admin, reuse the user_segment_id of an existing article from get_article). Defaults to everyone.',
          ),
        author_id: z
          .number()
          .int()
          .optional()
          .describe('Author user ID. Defaults to the authenticated user.'),
        content_tag_ids: z
          .array(z.string())
          .optional()
          .describe('Content tag IDs (use list_content_tags to find them)'),
        locale: z
          .string()
          .optional()
          .describe(
            'Source locale for the article, e.g. "en-us" or "fr". Defaults to the Help Center\'s default locale; becomes the article\'s source_locale.',
          ),
        draft: z
          .boolean()
          .default(true)
          .describe(
            'When true (default), the article is created unpublished; set false to publish immediately.',
          ),
        promoted: z
          .boolean()
          .default(false)
          .describe(
            'When true, marks the article as promoted (featured) in its section. Defaults to false.',
          ),
        label_names: z
          .array(z.string())
          .optional()
          .describe('Label names for search ranking (use list_labels to see existing labels)'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { section_id, ...articleData } = params as { section_id: number } & Record<
          string,
          unknown
        >;
        const token = await getToken();
        const { article } = await helpCenterPost<{ article: ZendeskArticle }>(
          subdomain,
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
        'Update article metadata only (draft, promoted, labels, tags, visibility, section, sort position, etc.) and return the updated article. Does NOT update content (title, body) — use update_article_translation for that.',
      inputSchema: z.object({
        article_id: z
          .number()
          .int()
          .describe(
            'Article ID — the numeric id of the article to update. Obtain it from list_articles or search_articles.',
          ),
        draft: z
          .boolean()
          .optional()
          .describe('Set true to unpublish the article (revert to draft) or false to publish it.'),
        promoted: z
          .boolean()
          .optional()
          .describe(
            'Set true to promote (feature) the article in its section, or false to unpromote it.',
          ),
        label_names: z
          .array(z.string())
          .optional()
          .describe('Label names for search ranking (use list_labels to see existing labels).'),
        content_tag_ids: z
          .array(z.string())
          .optional()
          .describe('Content tag ids to attach (use list_content_tags to find them).'),
        user_segment_id: z
          .number()
          .int()
          .optional()
          .describe(
            'User segment that controls who can see the article (id from list_user_segments; if that is forbidden because the token is not a Guide admin, reuse the user_segment_id of an existing article from get_article).',
          ),
        author_id: z
          .number()
          .int()
          .optional()
          .describe('User id of the article author (from search_users).'),
        permission_group_id: z
          .number()
          .int()
          .optional()
          .describe(
            'Guide permission group controlling who can edit (id from list_permission_groups; if that is forbidden because the token is not a Guide admin, reuse the permission_group_id of an existing article from get_article).',
          ),
        section_id: z
          .number()
          .int()
          .optional()
          .describe('Move the article to this section (numeric id from list_sections).'),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Sort position within the section (manual ordering only; 0 = first/top). New articles default to position 0. To move an article to the END of its section, set this to one more than the highest current position: read the highest position P from list_articles with sort_by="position", sort_order="desc", then set position = P + 1.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, ...updates } = params as { article_id: number } & Record<
          string,
          unknown
        >;
        const token = await getToken();
        const { article } = await helpCenterPut<{ article: ZendeskArticle }>(
          subdomain,
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
        'Reorder an article within its current section by moving it relative to its siblings (top, bottom, or before/after another article), and return whether the new order was applied. This is the reliable way to satisfy "put this article first/last" requests: it writes the minimal set of article positions needed to make the order deterministic, because Zendesk leaves newly created articles tied at position 0 where a plain position update is silently ambiguous. It does NOT move the article to a different section — use update_article with section_id for that. Zendesk exposes no way to read whether a section is manually or automatically sorted, so when the section is sorted automatically (by date or alphabetically) the position writes are ignored; this tool detects that after the fact and returns guidance to switch the section to manual ordering in Guide. A move may reposition several neighbouring articles; when that count exceeds a configurable safety threshold the call is refused unless confirm is set to true.',
      inputSchema: z.object({
        article_id: z
          .number()
          .int()
          .describe(
            'Article ID — the numeric id of the article to move within its section. Obtain it from list_articles or search_articles.',
          ),
        target: z
          .enum(['top', 'bottom', 'before', 'after'])
          .describe(
            'Where to move the article relative to its section siblings: "top" (becomes first), "bottom" (becomes last), or "before"/"after" a specific reference article. "before" and "after" require reference_article_id.',
          ),
        reference_article_id: z
          .number()
          .int()
          .optional()
          .describe(
            'The sibling article to position next to when target is "before" or "after" (numeric id from list_articles). Must belong to the same section and differ from article_id; leave it unset for "top" or "bottom".',
          ),
        normalize: z
          .boolean()
          .default(false)
          .describe(
            'When true, also renumber every article in the section to contiguous positions (0, 1, 2, …) so the stored positions stay tidy. Defaults to false, which writes the fewest positions possible and lets gaps remain. Either way the confirmation threshold still applies.',
          ),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            'Safety guard for large reorders. When the move would rewrite more article positions than the configured threshold (ZENDESK_REORDER_CONFIRM_THRESHOLD, default 20), the tool refuses and reports the count until you pass true here. Has no effect on small reorders.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const {
          article_id,
          target,
          reference_article_id,
          normalize = false,
          confirm = false,
        } = params as {
          article_id: number;
          target: ReorderTarget;
          reference_article_id?: number;
          normalize?: boolean;
          confirm?: boolean;
        };

        // Cross-field validation (the schema is a plain object; enforce the
        // target/reference relationship here, like archive_article's confirm guard).
        assertReorderParamsCoherent(article_id, target, reference_article_id);
        const needsReference = needsReferenceArticle(target);

        const token = await getToken();

        // Resolve the article's section (also validates the article exists).
        const { article } = await helpCenterGet<{ article: ZendeskArticle }>(
          subdomain,
          token,
          `/articles/${article_id}`,
        );
        const sectionId = article.section_id;
        // Scope every section listing to the article's locale — the endpoint
        // rejects a locale-less request when the section's default sort is
        // locale-dependent (see fetchSectionOrder).
        const locale = article.source_locale;

        const effective = await fetchSectionOrder(sectionId, locale, token);

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

        // A strict inversion in the effective order is definitive proof the
        // section ignores `position` (it is auto-sorted). Short-circuit before any
        // write, at any size — writing would be silently ignored regardless. The
        // post-write verification below still backstops the cases an inversion
        // cannot reveal up front (e.g. an auto order that happens to be ascending).
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

        const applied = await applyPositionWrites(writes, article_id, token);

        // Verify the move took effect (the definitive auto-sort check).
        const after = await fetchSectionOrder(sectionId, locale, token);
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
        'Archive (soft-delete) a Help Center article: it is removed from the Help Center but can be restored from the Guide admin UI. Returns a confirmation message; the article and all its translations become invisible to end users. This is the only removal the Zendesk API offers — permanent deletion is not available via the API (do it from the Guide admin UI). To only hide an article temporarily while keeping it in the knowledge base, use update_article with draft: true (unpublish) instead. Guarded by a required confirm flag.',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        confirm: z
          .boolean()
          .describe(
            'Explicit safety guard: must be set to true to archive the article. Any other value refuses the operation without calling Zendesk.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, confirm } = params as { article_id: number; confirm: boolean };
        if (confirm !== true) {
          throw new Error(
            'Archiving is guarded: pass confirm: true to archive (soft-delete) this article. No changes were made.',
          );
        }
        const token = await getToken();
        await helpCenterDelete(subdomain, token, `/articles/${article_id}`);
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
        'List Guide content tags, which are end-user-visible labels that help readers find related articles. Results are cursor-paginated (follow the returned cursor to enumerate the full list) and sorted by name by default. Pass name_prefix to look a tag up by the start of its name — do this before create_content_tag to reuse an existing tag rather than fragment the taxonomy. For internal, non-end-user search labels, see list_labels instead.',
      inputSchema: z.object({
        name_prefix: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Return only content tags whose name starts with this prefix (prefix match — not a substring or fuzzy search). Use the full name to check whether a specific tag already exists before creating it.',
          ),
        sort_by: z
          .enum(['name', 'id'])
          .default('name')
          .describe('Field to sort by; "name" (the default) lists tags alphabetically.'),
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
          .describe(
            'Content tags per page (1-30, default 30). The Guide content-tags endpoint caps each page at 30; follow the returned cursor to enumerate the full list.',
          ),
        cursor: z
          .string()
          .optional()
          .describe('Pagination cursor from a previous response; omit for the first page.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { name_prefix, sort_by, sort_order, page_size, cursor } = params as {
          name_prefix?: string;
          sort_by: string;
          sort_order: string;
          page_size: number;
          cursor?: string;
        };
        const token = await getToken();
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
        'Create a new content tag for Guide articles. Content tags are end-user visible labels that help readers discover related articles; this returns the created tag with its id. Check list_content_tags first (filter by name_prefix) to avoid duplicates, then attach the new id via the content_tag_ids parameter of create_article or update_article. For internal search-ranking labels that are not shown to end users, use article labels (list_labels) instead.',
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe('Content tag name as shown to end users (e.g., "billing", "getting-started").'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { name } = params as { name: string };
        const token = await getToken();
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
        'List all article labels. Labels improve Help Center search ranking and are not visible to end users.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async () => {
        const token = await getToken();
        const response = await helpCenterGet<{ labels: ZendeskLabel[]; count: number }>(
          subdomain,
          token,
          '/articles/labels',
        );
        return {
          content: [{ type: 'text', text: formatList(response.labels ?? [], formatLabel) }],
        };
      },
    },
    {
      name: 'list_user_segments',
      namespace: 'help_center',
      readOnly: true,
      title: 'List User Segments',
      description:
        'List all user segments. User segments control article visibility (who can view). Use the ID when creating or updating articles.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async () => {
        const token = await getToken();
        let response: { user_segments: ZendeskUserSegment[]; count: number };
        try {
          response = await helpCenterGet<{
            user_segments: ZendeskUserSegment[];
            count: number;
          }>(subdomain, token, '/user_segments');
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
            { type: 'text', text: formatList(response.user_segments ?? [], formatUserSegment) },
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
        'List all attachments for an article. Returns attachment metadata only (id, file name, content type, size, URL), not the file bytes; both inline and block attachments are included. This is for Help Center articles — for attachments on support tickets use get_ticket_attachments instead. Upload new files with create_article_attachment.',
      inputSchema: z.object({
        article_id: z
          .number()
          .int()
          .describe('ID of the Help Center article whose attachments to list.'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id } = params as { article_id: number };
        const token = await getToken();
        const response = await helpCenterGet<{
          article_attachments: ZendeskArticleAttachment[];
          count: number;
        }>(subdomain, token, `/articles/${article_id}/attachments`);
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
              text: formatList(attachments, formatAttachment),
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
        'Return a compact outline of an article (list of sections delimited by h1/h2/h3, with word counts) for the given locale (defaults to source_locale). Includes available translations with their outdated status. Use get_article_section to fetch a specific section.',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        locale: z
          .string()
          .optional()
          .describe('Locale of the body to outline (defaults to article source_locale)'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, locale } = params as { article_id: number; locale?: string };
        const token = await getToken();
        const { article } = await helpCenterGet<{ article: ZendeskArticle }>(
          subdomain,
          token,
          `/articles/${article_id}`,
        );
        const effectiveLocale = locale ?? article.source_locale;
        const { translation } = await helpCenterGet<{ translation: ZendeskTranslation }>(
          subdomain,
          token,
          `/articles/${article_id}/translations/${effectiveLocale}`,
        );
        const translations = await listTranslations(subdomain, token, article_id);
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
        'Retrieve the content of a single section of an article in a given locale. Use get_article_outline first to discover section indexes. Default format="html" for round-trip safety. Pass format="markdown" only for human review — the Markdown representation is lossy on some structures (<pre> with <br>, tables with multi-<p> cells are kept as raw HTML to limit the damage, but do not round-trip markdown content back through update_article_section).',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        locale: z.string().describe('Locale of the body (e.g., "en-us", "fr")'),
        section_index: z
          .number()
          .int()
          .min(0)
          .describe('0-based index of the section (see get_article_outline)'),
        format: z
          .enum(['html', 'markdown'])
          .default('html')
          .describe(
            'Output format. "html" (default) is round-trip safe. "markdown" is lossy on some HTML structures — use only for human review, not before update_article_section.',
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, locale, section_index, format } = params as {
          article_id: number;
          locale: string;
          section_index: number;
          format: 'html' | 'markdown';
        };
        const token = await getToken();
        const { translation } = await helpCenterGet<{ translation: ZendeskTranslation }>(
          subdomain,
          token,
          `/articles/${article_id}/translations/${locale}`,
        );
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
        return { content: [{ type: 'text', text: truncateIfNeeded(text) }] };
      },
    },
    {
      name: 'update_article_section',
      namespace: 'help_center',
      readOnly: false,
      title: 'Update Article Section',
      description:
        'Replace the content of a single section of an article in a given locale, keeping the rest of the body intact. The server fetches the current body, replaces the targeted section, and PUTs the full reconstructed body via the Translations API. Default format="html" for fidelity. Use format="markdown" only when you control the input and know it does not rely on structures that round-trip poorly (code blocks with line breaks, tables with multi-paragraph cells). The section heading is preserved and is NOT part of the replaced content.',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        locale: z.string().describe('Locale of the translation to update'),
        section_index: z
          .number()
          .int()
          .min(0)
          .describe('0-based index of the section to replace (see get_article_outline)'),
        content: z
          .string()
          .describe(
            'New content for the section (heading excluded). HTML by default, Markdown if format="markdown".',
          ),
        format: z
          .enum(['html', 'markdown'])
          .default('html')
          .describe(
            'Input format. "html" (default) is the safe path. "markdown" is converted to HTML server-side but may introduce artifacts on complex content.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, locale, section_index, content, format } = params as {
          article_id: number;
          locale: string;
          section_index: number;
          content: string;
          format: 'html' | 'markdown';
        };
        const token = await getToken();
        const { translation } = await helpCenterGet<{ translation: ZendeskTranslation }>(
          subdomain,
          token,
          `/articles/${article_id}/translations/${locale}`,
        );
        const newSectionHtml = format === 'markdown' ? markdownToHtml(content) : content;
        const newBody = replaceSectionContent(translation.body, section_index, newSectionHtml);
        const { translation: updated } = await helpCenterPut<{ translation: ZendeskTranslation }>(
          subdomain,
          token,
          `/articles/${article_id}/translations/${locale}`,
          { translation: { body: newBody } },
        );
        const updatedSections = parseSections(updated.body);
        const updatedSection = updatedSections[section_index];
        const newWordCount = updatedSection?.wordCount ?? 0;
        const headingLabel = updatedSection?.heading ?? '(intro)';
        const text = [
          `Section [${section_index}] "${headingLabel}" updated for article #${article_id} (${locale}).`,
          `New word count: ${newWordCount}.`,
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
        'Compare two locales of the same article to decide whether the target translation needs work, reporting independent signals instead of one ambiguous verdict. (1) Header — a "Freshness" verdict for the target, derived from the two translations\' updated_at timestamps: if the source was edited after the target it is "likely behind, review recommended" (with the day gap), otherwise "up to date". This is the primary staleness signal and is always available. (2) Zendesk\'s own per-translation "outdated" flag for the target ("yes"/"no"/"unknown"), shown as a secondary overlay: it is only set through Guide\'s native "mark out of date" workflow and NOT by API edits, so a "no" does not by itself mean current — prefer Freshness. (3) A global structure check (section count and heading-tag sequence); on mismatch the header warns the per-index rows may be misaligned. (4) A per-section table matched by index, status "ok" (present in both), "missing" (present in source, absent in target) or "extra" (present in target, absent in source). (5) Per-section source/target word counts, INFORMATIONAL ONLY: a length difference between languages is normal and is deliberately NOT flagged as a divergence — do not read a word-count gap as an edit regression or staleness. Read-only; performs three Help Center GET calls (both translations plus the translations list for the outdated flag).',
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        source_locale: z
          .string()
          .describe(
            'Reference locale to diff against, e.g. "en-us". Usually the article source_locale (from get_article).',
          ),
        target_locale: z.string().describe('Target locale to compare against source'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, source_locale, target_locale } = params as {
          article_id: number;
          source_locale: string;
          target_locale: string;
        };
        const token = await getToken();
        const [sourceRes, targetRes, translations] = await Promise.all([
          helpCenterGet<{ translation: ZendeskTranslation }>(
            subdomain,
            token,
            `/articles/${article_id}/translations/${source_locale}`,
          ),
          helpCenterGet<{ translation: ZendeskTranslation }>(
            subdomain,
            token,
            `/articles/${article_id}/translations/${target_locale}`,
          ),
          // The `outdated` flag is only exposed on the list endpoint, not on a
          // single-translation GET — same reason get_article_outline lists too.
          listTranslations(subdomain, token, article_id),
        ]);
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
        "Upload a file to a Help Center article and return the created attachment (its id, file name, content type, size and content URL). Not idempotent: calling it again uploads another copy rather than replacing the previous one. This is for article assets — for files on support tickets use get_ticket_attachments, and to see an article's existing attachments use list_article_attachments.",
      inputSchema: z.object({
        article_id: z.number().int().describe(ARTICLE_ID_DESC),
        file_name: z
          .string()
          .min(1)
          .describe(
            'Name to store the file under, including its extension (e.g. "screenshot.png"); used as the download name.',
          ),
        file_base64: z
          .string()
          .min(1)
          .describe(
            "The file's raw bytes as a base64-encoded string; the server decodes them before upload.",
          ),
        content_type: z
          .string()
          .default('application/octet-stream')
          .describe(
            'MIME type of the file, e.g. "image/png" or "application/pdf". Defaults to application/octet-stream when omitted.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { article_id, file_name, file_base64, content_type } = params as {
          article_id: number;
          file_name: string;
          file_base64: string;
          content_type: string;
        };
        const token = await getToken();
        const buffer = Buffer.from(file_base64, 'base64');
        const blob = new Blob([buffer], { type: content_type });
        const formData = new FormData();
        formData.append('file', blob, file_name);
        const { article_attachment } = await helpCenterUpload<{
          article_attachment: ZendeskArticleAttachment;
        }>(subdomain, token, `/articles/${article_id}/attachments`, formData);
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
