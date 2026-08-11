#!/usr/bin/env tsx
/**
 * Ground-truth capture for the `translations` sideload on the section/category
 * list endpoints (issue #226).
 *
 * find_translation_gaps classifies each node as "no translation" / "draft" /
 * "published", which today costs one `GET /{sections|categories}/{id}/translations`
 * per node (waves of 5, capped by ZENDESK_TRANSLATION_GAP_SCAN_MAX_NODES). Both
 * list endpoints document a `translations` sideload that would collapse that
 * fan-out into two requests — but the docs never state which *fields* a sideloaded
 * translation carries, and `draft` is the entire point of the audit. So the
 * redesign hinges on measurement, not on the docs.
 *
 * This one-shot, READ-ONLY probe prints the raw JSON and answers, in order:
 *   1. Does a sideloaded translation carry `draft`?          <- decisive
 *   2. Does it carry *every* locale, not just the source one?
 *   3. What is the shape — embedded per node, or a top-level array keyed by
 *      `source_id`? (The docs say embedded; this confirms it.)
 *   4. Does it survive `page[size]=100` + pagination unchanged?
 *   5. Does the locale-prefixed variant (`/{locale}/sections`) return something
 *      different?
 * Plus: are DRAFT translations present in the sideload at all (a sideload that
 * silently omits drafts would read as "no translation" and is unusable), and does
 * `include=categories,translations` carry category translations too — which would
 * collapse the audit to a *single* request.
 *
 * The decisive test is the per-node cross-check: for a sample of nodes it diffs
 * the sideloaded translations against `GET /{kind}/{id}/translations` field by
 * field. Equal on every sampled node (drafts included) is what makes the sideload
 * a drop-in replacement; anything else is reported as a mismatch.
 *
 * Usage (zero setup in an env where the zendesk-local MCP server is configured):
 *   pnpm tsx scripts/probe-translations-sideload.ts [locale] [sample_size]
 *
 * `locale` (default "fr") is only used for the locale-prefixed variant and the
 * per-locale summary; the audit itself reads every locale. `sample_size`
 * (default 5) is how many nodes per level get the per-node cross-check.
 * The subdomain is read from ZENDESK_SUBDOMAIN, else from the zendesk-local entry
 * in .mcp.json. The token is read from ZENDESK_OAUTH_TOKEN, else from the access
 * token cached on disk when the server was authenticated once. Override either:
 *   ZENDESK_SUBDOMAIN=fruggr ZENDESK_OAUTH_TOKEN=<token> \
 *     pnpm tsx scripts/probe-translations-sideload.ts fr 5
 *
 * Paste the output into issue #226 — that payload is the whole basis for the
 * redesign. Localized names/descriptions are truncated to a short preview (a
 * description can be long, and is tenant content), never dumped whole.
 */
import { readFileSync } from 'node:fs';
import { loadToken, resolveTokenPath } from '../src/auth/token-persistence';
import { helpCenterGet } from '../src/client/zendesk-api';

const [cliLocale, cliSample] = process.argv.slice(2);
if (cliSample !== undefined && !/^\d+$/.test(cliSample)) {
  console.error(
    'Usage: pnpm tsx scripts/probe-translations-sideload.ts [locale] [sample_size]\n' +
      '  sample_size (optional) must be numeric — how many nodes per level to cross-check.',
  );
  process.exit(1);
}
const locale = cliLocale ?? 'fr';
const sampleSize = cliSample ? Number(cliSample) : 5;

const resolveSubdomain = (): string => {
  const fromEnv = process.env['ZENDESK_SUBDOMAIN'];
  if (fromEnv) return fromEnv;
  try {
    const mcp = JSON.parse(readFileSync(new URL('../.mcp.json', import.meta.url), 'utf8'));
    const sub = mcp?.mcpServers?.['zendesk-local']?.env?.ZENDESK_SUBDOMAIN;
    if (typeof sub === 'string' && sub) return sub;
  } catch {
    // fall through to the error below
  }
  console.error(
    'No Zendesk subdomain. Set ZENDESK_SUBDOMAIN, or run from a checkout whose ' +
      '.mcp.json configures the zendesk-local server.',
  );
  process.exit(1);
};

const subdomain = resolveSubdomain();

const resolveToken = (): string => {
  const fromEnv = process.env['ZENDESK_OAUTH_TOKEN'];
  if (fromEnv) return fromEnv;
  const cached = loadToken(resolveTokenPath(subdomain));
  if (cached?.accessToken) return cached.accessToken;
  console.error(
    `No token available. Export ZENDESK_OAUTH_TOKEN, or authenticate the server once for "${subdomain}" ` +
      `so a token is cached at ${resolveTokenPath(subdomain)}.`,
  );
  process.exit(1);
};

const dump = (label: string, value: unknown): void => {
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(value, null, 2));
};

type Json = Record<string, unknown>;

const PREVIEW_CHARS = 60;

// Tenant content: keep localized name/description to a short preview. The audit
// only ever needs locale + draft, so nothing decisive is hidden by this.
const preview = (value: unknown): unknown =>
  typeof value === 'string' && value.length > PREVIEW_CHARS
    ? `${value.slice(0, PREVIEW_CHARS)}… (${value.length} chars)`
    : value;

// The three fields the audit actually reads, plus the sideload's back-reference.
const digest = (t: Json): Json => ({
  locale: t['locale'],
  draft: t['draft'],
  has_draft_field: 'draft' in t,
  title: preview(t['title']),
  source_id: t['source_id'],
  source_type: t['source_type'],
});

const byLocale = (a: string, b: string): number => a.localeCompare(b);

const sortByLocale = (translations: Json[]): Json[] =>
  [...translations].sort((a, b) => byLocale(String(a['locale']), String(b['locale'])));

// Field-by-field equality on what the classifier consumes. A sideload that agrees
// on locales but disagrees on `draft` is worse than useless — it would silently
// report a draft node as published.
const diffTranslations = (
  sideloaded: Json[],
  perNode: Json[],
): { equal: boolean; details: Json } => {
  const localesOf = (list: Json[]): string[] =>
    list.map((t) => String(t['locale']).toLowerCase()).sort(byLocale);
  const draftsOf = (list: Json[]): Json =>
    Object.fromEntries(list.map((t) => [String(t['locale']).toLowerCase(), t['draft']]));

  const sideLocales = localesOf(sideloaded);
  const nodeLocales = localesOf(perNode);
  const sideDrafts = draftsOf(sideloaded);
  const nodeDrafts = draftsOf(perNode);
  const localesEqual = JSON.stringify(sideLocales) === JSON.stringify(nodeLocales);
  const draftsEqual = JSON.stringify(sideDrafts) === JSON.stringify(nodeDrafts);
  const missingFromSideload = nodeLocales.filter((l) => !sideLocales.includes(l));
  const extraInSideload = sideLocales.filter((l) => !nodeLocales.includes(l));

  return {
    equal: localesEqual && draftsEqual,
    details: {
      locales_equal: localesEqual,
      drafts_equal: draftsEqual,
      sideloaded_locales: sideLocales,
      per_node_locales: nodeLocales,
      ...(missingFromSideload.length > 0 ? { MISSING_FROM_SIDELOAD: missingFromSideload } : {}),
      ...(extraInSideload.length > 0 ? { EXTRA_IN_SIDELOAD: extraInSideload } : {}),
      ...(draftsEqual ? {} : { DRAFT_MISMATCH: { sideloaded: sideDrafts, per_node: nodeDrafts } }),
    },
  };
};

const translationsOf = (node: Json): Json[] => {
  const raw = node['translations'];
  return Array.isArray(raw) ? (raw as Json[]) : [];
};

const listWithSideload = async (
  token: string,
  path: string,
  include: string,
): Promise<{ response: Json; nodes: Json[] }> => {
  const response = await helpCenterGet<Json>(subdomain, token, path, {
    include,
    'page[size]': '100',
  });
  const key = path.includes('categories') ? 'categories' : 'sections';
  const nodes = (response[key] as Json[] | undefined) ?? [];
  return { response, nodes };
};

interface LevelFindings {
  kind: 'sections' | 'categories';
  nodeCount: number;
  nodesWithTranslationsKey: number;
  topLevelTranslationsArray: boolean;
  everyTranslationHasDraft: boolean;
  draftCount: number;
  crossChecked: number;
  mismatches: number;
  draftsCrossChecked: number;
}

const probeLevel = async (
  token: string,
  kind: 'sections' | 'categories',
  activeLocales: string[],
): Promise<LevelFindings> => {
  const { response, nodes } = await listWithSideload(token, `/${kind}`, 'translations');

  console.log(`\n\n############ ${kind.toUpperCase()} — include=translations ############`);
  dump(`GET /${kind}?include=translations&page[size]=100 — top-level keys`, Object.keys(response));
  console.log(`\n(${nodes.length} ${kind} returned)`);

  // (3) Shape: embedded per node (what the docs claim), or a top-level array?
  const topLevel = response['translations'];
  const topLevelTranslationsArray = Array.isArray(topLevel);
  dump('(3) SHAPE — where do the translations live?', {
    top_level_translations_key_present: 'translations' in response,
    top_level_is_array: topLevelTranslationsArray,
    top_level_length: Array.isArray(topLevel) ? topLevel.length : null,
    first_node_has_translations_key: nodes[0] ? 'translations' in nodes[0] : null,
    first_node_translations_is_array: nodes[0] ? Array.isArray(nodes[0]['translations']) : null,
    nodes_with_translations_key: nodes.filter((n) => 'translations' in n).length,
  });

  if (nodes.length === 0) {
    console.error(`\nNo ${kind} on this tenant — nothing to measure at this level.`);
    return {
      kind,
      nodeCount: 0,
      nodesWithTranslationsKey: 0,
      topLevelTranslationsArray,
      everyTranslationHasDraft: false,
      draftCount: 0,
      crossChecked: 0,
      mismatches: 0,
      draftsCrossChecked: 0,
    };
  }

  // (1) THE decisive field. Dumped raw first — unfiltered, so nothing is hidden
  // behind the digest below.
  const firstNode = nodes[0] as Json;
  const firstTranslations = translationsOf(firstNode);
  dump(`(1) RAW — first ${kind.slice(0, -1)}'s node keys`, Object.keys(firstNode));
  dump(
    `(1) RAW — first ${kind.slice(0, -1)}'s FIRST sideloaded translation, verbatim (does it carry "draft"?)`,
    firstTranslations[0] ?? '(no sideloaded translation on this node)',
  );
  dump(
    '(1) sideloaded translation FIELD NAMES (compare with the per-node endpoint below)',
    firstTranslations[0] ? Object.keys(firstTranslations[0]).sort() : '(none)',
  );

  const allTranslations = nodes.flatMap(translationsOf);
  const withoutDraftField = allTranslations.filter((t) => !('draft' in t));
  const everyTranslationHasDraft = allTranslations.length > 0 && withoutDraftField.length === 0;
  const draftCount = allTranslations.filter((t) => t['draft'] === true).length;
  dump('(1) VERDICT INPUT — "draft" across every sideloaded translation', {
    sideloaded_translations_total: allTranslations.length,
    carrying_draft_field: allTranslations.length - withoutDraftField.length,
    MISSING_draft_field: withoutDraftField.length,
    draft_true_count: draftCount,
    draft_false_count: allTranslations.filter((t) => t['draft'] === false).length,
  });

  // (2) Every locale, or only the source one? Compared against /locales.
  const localesSeen = [
    ...new Set(allTranslations.map((t) => String(t['locale']).toLowerCase())),
  ].sort();
  dump('(2) LOCALE COVERAGE — locales present in the sideload vs. active locales', {
    active_locales: activeLocales,
    locales_in_sideload: localesSeen,
    active_locales_never_sideloaded: activeLocales
      .map((l) => l.toLowerCase())
      .filter((l) => !localesSeen.includes(l)),
    nodes_with_more_than_one_locale: nodes.filter((n) => translationsOf(n).length > 1).length,
    per_node_translation_counts: nodes.slice(0, 10).map((n) => ({
      id: n['id'],
      name: preview(n['name']),
      translations: translationsOf(n).length,
    })),
  });

  dump(
    `(2) digest — first ${Math.min(3, nodes.length)} ${kind} with every locale they carry`,
    nodes.slice(0, 3).map((n) => ({
      id: n['id'],
      name: preview(n['name']),
      locale: n['locale'],
      source_locale: n['source_locale'],
      translations: sortByLocale(translationsOf(n)).map(digest),
    })),
  );

  // (4) Pagination with the sideload — unchanged meta, nothing truncated?
  dump('(4) PAGINATION with the sideload', {
    returned: nodes.length,
    count: response['count'],
    next_page: response['next_page'],
    meta: response['meta'],
    links: response['links'],
  });

  // THE cross-check: sideload vs. per-node endpoint, field by field. Nodes whose
  // sideload shows a draft are sampled FIRST — a sideload that agrees on published
  // nodes and lies about drafts would break the audit in exactly the case it exists
  // for.
  const draftFirst = [
    ...nodes.filter((n) => translationsOf(n).some((t) => t['draft'] === true)),
    ...nodes.filter((n) => !translationsOf(n).some((t) => t['draft'] === true)),
  ];
  const sample = draftFirst.slice(0, sampleSize);
  const crossChecks: Json[] = [];
  let mismatches = 0;
  let draftsCrossChecked = 0;
  for (const node of sample) {
    const nodeId = Number(node['id']);
    const perNodeResp = await helpCenterGet<{ translations?: Json[] }>(
      subdomain,
      token,
      `/${kind}/${nodeId}/translations`,
    );
    const perNode = perNodeResp.translations ?? [];
    const sideloaded = translationsOf(node);
    const diff = diffTranslations(sideloaded, perNode);
    if (!diff.equal) mismatches += 1;
    if (perNode.some((t) => t['draft'] === true)) draftsCrossChecked += 1;
    crossChecks.push({
      id: nodeId,
      name: preview(node['name']),
      equal: diff.equal,
      ...diff.details,
      sideloaded: sortByLocale(sideloaded).map(digest),
      per_node: sortByLocale(perNode).map(digest),
      per_node_field_names: perNode[0] ? Object.keys(perNode[0]).sort() : '(none)',
    });
  }
  dump(
    `CROSS-CHECK — sideload vs. GET /${kind}/{id}/translations on ${sample.length} node(s), drafts first`,
    crossChecks,
  );

  return {
    kind,
    nodeCount: nodes.length,
    nodesWithTranslationsKey: nodes.filter((n) => 'translations' in n).length,
    topLevelTranslationsArray,
    everyTranslationHasDraft,
    draftCount,
    crossChecked: sample.length,
    mismatches,
    draftsCrossChecked,
  };
};

const main = async (): Promise<void> => {
  const token = resolveToken();

  // (0) Token identity — draft translations are only visible to an agent/admin, so
  // an end-user token would make every draft look absent. Print the role.
  try {
    const me = await helpCenterGet<Json>(subdomain, token, '/users/me');
    const user = (me['user'] as Json | undefined) ?? me;
    dump('GET /users/me — token identity (drafts need agent/admin)', {
      id: user['id'],
      role: user['role'],
      role_type: user['role_type'],
    });
  } catch (e) {
    console.log(`\n(could not read /users/me: ${e instanceof Error ? e.message : e})`);
  }

  const localesResp = await helpCenterGet<{ locales?: string[]; default_locale?: string }>(
    subdomain,
    token,
    '/locales',
  );
  const activeLocales = localesResp.locales ?? [];
  dump('GET /locales — active locales', localesResp);

  const sections = await probeLevel(token, 'sections', activeLocales);
  const categories = await probeLevel(token, 'categories', activeLocales);

  // Bonus: the docs say "Category translations are only sideloaded if categories
  // are". If sections?include=categories,translations carries both, the audit is
  // ONE request, not two.
  console.log('\n\n############ BONUS — include=categories,translations on /sections ############');
  try {
    const { response, nodes } = await listWithSideload(
      token,
      '/sections',
      'categories,translations',
    );
    const sideloadedCategories = (response['categories'] as Json[] | undefined) ?? [];
    dump('GET /sections?include=categories,translations — top-level keys', Object.keys(response));
    dump('do the sideloaded CATEGORIES carry their own translations?', {
      sections_returned: nodes.length,
      categories_sideloaded: sideloadedCategories.length,
      categories_with_translations_key: sideloadedCategories.filter((c) => 'translations' in c)
        .length,
      first_category: sideloadedCategories[0]
        ? {
            id: sideloadedCategories[0]['id'],
            name: preview(sideloadedCategories[0]['name']),
            keys: Object.keys(sideloadedCategories[0]).sort(),
            translations: sortByLocale(translationsOf(sideloadedCategories[0])).map(digest),
          }
        : '(no categories sideloaded)',
    });
  } catch (e) {
    console.log(`(combined sideload failed: ${e instanceof Error ? e.message : e})`);
  }

  // (5) Locale-prefixed variant — irrelevant if the unprefixed listing already
  // carries every locale, but measured rather than assumed.
  console.log(`\n\n############ (5) LOCALE-PREFIXED — /${locale}/sections ############`);
  try {
    const { response, nodes } = await listWithSideload(
      token,
      `/${locale}/sections`,
      'translations',
    );
    const all = nodes.flatMap(translationsOf);
    dump(`GET /${locale}/sections?include=translations — does it differ?`, {
      top_level_keys: Object.keys(response),
      sections_returned: nodes.length,
      sideloaded_translations_total: all.length,
      locales_in_sideload: [...new Set(all.map((t) => String(t['locale']).toLowerCase()))].sort(),
      every_translation_has_draft: all.length > 0 && all.every((t) => 'draft' in t),
      first_translation: all[0] ?? '(none)',
    });
  } catch (e) {
    console.log(`(locale-prefixed listing failed: ${e instanceof Error ? e.message : e})`);
  }

  // ---- Verdict. Step 1 of #226 is a gate: no `draft` in the sideload and the
  // redesign is dead, whatever the rest says.
  const levels = [sections, categories];
  const draftFieldEverywhere = levels.every((l) => l.nodeCount === 0 || l.everyTranslationHasDraft);
  const noMismatch = levels.every((l) => l.mismatches === 0);
  const draftObserved = levels.some((l) => l.draftCount > 0);
  const draftCrossChecked = levels.some((l) => l.draftsCrossChecked > 0);
  const requestsToday = 1 + levels.reduce((n, l) => n + l.nodeCount, 0) + 1;

  console.log('\n\n############ VERDICT (issue #226) ############\n');
  console.log(
    JSON.stringify(
      {
        per_level: levels,
        '1_sideload_carries_draft': draftFieldEverywhere,
        '2_cross_check_agrees_with_per_node_endpoint': noMismatch,
        '3_draft_true_observed_somewhere': draftObserved,
        '4_a_draft_node_was_cross_checked': draftCrossChecked,
        requests_today_for_a_full_audit: requestsToday,
        requests_with_sideload: 2,
      },
      null,
      2,
    ),
  );

  if (!draftFieldEverywhere) {
    console.log(
      '\n=> NOT VIABLE: a sideloaded translation does NOT carry "draft". Per step 1 of #226 ' +
        'the sideload cannot replace the per-node read — keep the fan-out and close the issue.',
    );
    return;
  }
  if (!noMismatch) {
    console.log(
      '\n=> NOT VIABLE AS-IS: the sideload disagrees with the per-node endpoint (see DRAFT_MISMATCH / ' +
        'MISSING_FROM_SIDELOAD above). Classifying from it would misreport those nodes.',
    );
    return;
  }
  console.log(
    '\n=> VIABLE: every sideloaded translation carries "draft" and agrees with the per-node ' +
      `endpoint on every sampled node. A full audit goes from ~${requestsToday} requests to 2.`,
  );
  if (!draftCrossChecked) {
    console.log(
      '   CAVEAT: no node with a DRAFT translation was cross-checked, so "drafts are not silently ' +
        'omitted from the sideload" is unproven — the one failure mode that would make the audit ' +
        'report a draft as published. Create a draft translation on a throwaway section ' +
        '(set_section_translation with draft: true) and re-run before relying on this.',
    );
  }
};

main().catch((error) => {
  console.error(
    'probe-translations-sideload failed:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
