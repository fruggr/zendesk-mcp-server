#!/usr/bin/env tsx
/**
 * Read-only probe for #423 (topic 4): how images embedded in HTML email bodies
 * (signatures, logos) show up among a ticket's comment attachments.
 *
 *   Q1. Which keys does an attachment carry in `GET /tickets/:id/comments`?
 *       Is there one beyond `inline` that marks an embedded image?
 *   Q2. Which attachments appear only with `include_inline_images=true`, and
 *       is `inline` true for exactly those?
 *   Q3. Images repeated across a ticket's comments (same name hash and size,
 *       the shape of a signature): how is their `inline` flag split?
 *   Q4. Is each image referenced from its comment's `html_body` (by id or
 *       download token)? Does that line up with `inline`?
 *   Q5. Sizes and dimensions of repeated images versus one-off images.
 *   Q6. How much the repeats inflate the image count of a ticket.
 *
 * GETs only. It prints ids, flags, extensions, sizes, counts and an 8-char
 * hash of each file name — never a subject, a body, a file name or a URL — so
 * the output can be pasted into a PR comment.
 *
 * Usage (credentials resolved by `live-auth.ts`, never by the caller):
 *   pnpm tsx scripts/probe-inline-images.ts [--ticket <id>]... [--limit <n>] [--pages <n>]
 * Without --ticket it samples the most recently updated email tickets.
 */
import { createHash } from 'node:crypto';
import { zendeskGet } from '../src/client/zendesk-api';
import { buildCursorParams } from '../src/utils/pagination';
import { missingTokenHelp, resolveLiveSubdomain, resolveLiveToken } from './live-auth';

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const argValues = (flag: string): string[] =>
  process.argv.flatMap((arg, i) =>
    arg === flag && process.argv[i + 1] ? [process.argv[i + 1] as string] : [],
  );

const limit = Number(argValues('--limit')[0] ?? 15);
const maxPages = Number(argValues('--pages')[0] ?? 3);
const givenTickets = argValues('--ticket').map(Number).filter(Number.isInteger);

const subdomain =
  resolveLiveSubdomain() ??
  fail('No subdomain: set ZENDESK_SUBDOMAIN, or run from a checkout whose .mcp.json declares one.');
const source = resolveLiveToken(subdomain) ?? fail(missingTokenHelp(subdomain));
const token = await source.getToken();

// A probe step that fails is a finding, not a reason to stop the run.
const attempt = async <T>(label: string, run: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await run();
  } catch (error) {
    console.log(`${label} FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

interface RawAttachment {
  id: number;
  file_name: string;
  content_url: string;
  content_type: string;
  size: number;
  inline?: boolean;
  width?: number | string | null;
  height?: number | string | null;
  [key: string]: unknown;
}

interface RawComment {
  id: number;
  html_body?: string;
  via?: { channel?: string };
  attachments?: RawAttachment[];
}

interface CommentsPage {
  comments: RawComment[];
  meta?: { has_more: boolean; after_cursor: string };
}

const hash8 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 8);
const extension = (name: string): string => name.split('.').at(-1)?.toLowerCase() ?? '';
const downloadToken = (url: string): string | undefined => url.match(/\/token\/([^/]+)/)?.[1];

const walkComments = async (
  ticketId: number,
  inline: boolean,
): Promise<RawComment[] | undefined> => {
  const all: RawComment[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params = { ...buildCursorParams(100, cursor), include_inline_images: String(inline) };
    const response = await attempt(
      `GET /tickets/${ticketId}/comments include_inline_images=${inline}`,
      () => zendeskGet<CommentsPage>(subdomain, token, `/tickets/${ticketId}/comments`, params),
    );
    if (!response) return all.length ? all : undefined;
    all.push(...response.comments);
    if (!response.meta?.has_more || !response.meta.after_cursor) break;
    cursor = response.meta.after_cursor;
  }
  return all;
};

const discoverTickets = async (): Promise<number[]> => {
  const result = await attempt('GET /search (email tickets)', () =>
    zendeskGet<{ results: Array<{ id: number }> }>(subdomain, token, '/search', {
      query: 'type:ticket via:mail',
      sort_by: 'updated_at',
      sort_order: 'desc',
      per_page: String(limit),
    }),
  );
  return (result?.results ?? []).map((ticket) => ticket.id).slice(0, limit);
};

const tickets = givenTickets.length ? givenTickets : await discoverTickets();
console.log(
  `tickets sampled: ${tickets.length} (${givenTickets.length ? 'given' : 'search via:mail'})`,
);

const keyUnion = new Set<string>();
const totals = {
  images: 0,
  repeatedImages: 0,
  repeatedInlineTrue: 0,
  repeatedInlineFalse: 0,
  onlyWithInline: 0,
  onlyWithInlineFlagTrue: 0,
  bothFlagTrue: 0,
  referencedInlineTrue: 0,
  referencedInlineFalse: 0,
  unreferencedInlineTrue: 0,
  unreferencedInlineFalse: 0,
};

for (const ticketId of tickets) {
  const withInline = await walkComments(ticketId, true);
  const without = await walkComments(ticketId, false);
  if (!withInline) continue;

  const idsWithout = new Set(
    (without ?? []).flatMap((c) => (c.attachments ?? []).map((a) => a.id)),
  );
  const channels = [...new Set(withInline.map((c) => c.via?.channel ?? '?'))].join('/');
  console.log(`\n## ticket ${ticketId}: ${withInline.length} comments, channels ${channels}`);
  if (!without) console.log('  (no comparison: the include_inline_images=false walk failed)');

  const images = withInline.flatMap((comment, index) =>
    (comment.attachments ?? []).map((a) => {
      for (const key of Object.keys(a)) keyUnion.add(key);
      const body = comment.html_body ?? '';
      const tok = downloadToken(a.content_url);
      return {
        comment: index,
        a,
        key: `${hash8(a.file_name)}:${a.size}`,
        referenced: body.includes(String(a.id)) || (tok !== undefined && body.includes(tok)),
        onlyWithInline: without !== undefined && !idsWithout.has(a.id),
        imgTags: (body.match(/<img\b/gi) ?? []).length,
      };
    }),
  );

  const counts = new Map<string, number>();
  for (const image of images) counts.set(image.key, (counts.get(image.key) ?? 0) + 1);

  for (const { comment, a, key, referenced, onlyWithInline, imgTags } of images) {
    const isImage = a.content_type.startsWith('image/');
    const repeats = counts.get(key) ?? 1;
    console.log(
      `  c${comment} att ${a.id} ${isImage ? 'img' : 'file'} .${extension(a.file_name)} ${a.content_type} ` +
        `size=${a.size} ${a.width ?? '-'}x${a.height ?? '-'} inline=${a.inline} ` +
        `onlyWithInline=${onlyWithInline} referencedInHtml=${referenced} imgTagsInComment=${imgTags} ` +
        `nameHash=${key.split(':')[0]} repeats=${repeats}`,
    );
    if (!isImage) continue;
    totals.images += 1;
    if (repeats > 1) {
      totals.repeatedImages += 1;
      if (a.inline) totals.repeatedInlineTrue += 1;
      else totals.repeatedInlineFalse += 1;
    }
    if (onlyWithInline) {
      totals.onlyWithInline += 1;
      if (a.inline) totals.onlyWithInlineFlagTrue += 1;
    } else if (a.inline) totals.bothFlagTrue += 1;
    if (referenced && a.inline) totals.referencedInlineTrue += 1;
    if (referenced && !a.inline) totals.referencedInlineFalse += 1;
    if (!referenced && a.inline) totals.unreferencedInlineTrue += 1;
    if (!referenced && !a.inline) totals.unreferencedInlineFalse += 1;
  }
  const distinct = new Set(
    images.filter((i) => i.a.content_type.startsWith('image/')).map((i) => i.key),
  );
  console.log(
    `  images=${images.filter((i) => i.a.content_type.startsWith('image/')).length} distinct(nameHash+size)=${distinct.size}`,
  );
}

console.log(
  `\nattachment keys seen: ${[...keyUnion].sort((a, b) => a.localeCompare(b)).join(', ')}`,
);
console.log('totals (images only):');
for (const [name, value] of Object.entries(totals)) console.log(`  ${name}=${value}`);
