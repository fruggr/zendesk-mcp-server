#!/usr/bin/env tsx
/**
 * Read-only ground-truth probe for GET /tickets/{id}/comments (#265).
 *
 * The formatted tool output cannot answer two questions this feature rests on,
 * because both live in the raw upstream payload:
 *
 *   1. Does Zendesk accept `sort=-created_at` alongside cursor pagination
 *      (`page[size]`/`page[after]`)? Its docs make `sort_order` offset-only and
 *      point cursor callers at `sort`, but only a live call proves it.
 *   2. Does the `include=users` side-load carry the *comment authors*? The docs
 *      only promise email CCs, which is why list_ticket_comments falls back to a
 *      batched /users/show_many.
 *
 * It performs GETs only, prints the query it sent, the response's top-level
 * keys, `meta`, and a redacted per-comment/per-user summary (ids, timestamps,
 * body length — never body text), then follows one cursor page.
 *
 * Usage (auth is the one the running server already uses):
 *   pnpm tsx scripts/probe-ticket-comments.ts <ticket_id>
 *
 * Auth is the one the running server already uses, so a session that can call
 * the MCP tools can run this with no setup: the subdomain comes from
 * ZENDESK_SUBDOMAIN or, failing that, from the committed .mcp.json; the token
 * from ZENDESK_OAUTH_TOKEN or, failing that, from the same cached token file
 * the stdio server reads (docs/live-testing.md).
 */
import { readFileSync } from 'node:fs';
import { loadToken, resolveTokenPath } from '../src/auth/token-persistence';
import { getBaseUrl } from '../src/constants';

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

// The project-scoped MCP config names the tenant the local server points at, so
// it is the right fallback when the shell has no ZENDESK_SUBDOMAIN.
const subdomainFromMcpConfig = (): string | undefined => {
  try {
    const raw: unknown = JSON.parse(readFileSync('.mcp.json', 'utf8'));
    const servers = (raw as { mcpServers?: Record<string, { env?: Record<string, string> }> })
      .mcpServers;
    for (const server of Object.values(servers ?? {})) {
      const value = server.env?.['ZENDESK_SUBDOMAIN'];
      if (value) return value;
    }
  } catch {
    // absent or malformed → no subdomain from here
  }
  return undefined;
};

const ticketId = process.argv[2];
if (!ticketId) fail('Usage: pnpm tsx scripts/probe-ticket-comments.ts <ticket_id>');

const subdomain = process.env['ZENDESK_SUBDOMAIN'] ?? subdomainFromMcpConfig();
if (!subdomain) {
  fail('No subdomain: set ZENDESK_SUBDOMAIN, or run from a checkout whose .mcp.json declares one.');
}

const token =
  process.env['ZENDESK_OAUTH_TOKEN'] ??
  loadToken(resolveTokenPath(subdomain as string))?.accessToken;
if (!token) {
  fail(
    `No token: set ZENDESK_OAUTH_TOKEN, or sign in once so the store at ${resolveTokenPath(subdomain as string)} is populated (docs/live-testing.md).`,
  );
}
console.log(
  `Probing ${subdomain} with the ${process.env['ZENDESK_OAUTH_TOKEN'] ? 'ZENDESK_OAUTH_TOKEN' : 'cached token store'} credential.`,
);

interface ProbeComment {
  id?: number;
  author_id?: number;
  public?: boolean;
  created_at?: string;
  body?: string;
}
interface ProbeUser {
  id?: number;
  name?: string;
}
interface ProbeResponse {
  comments?: ProbeComment[];
  users?: ProbeUser[];
  meta?: { has_more?: boolean; after_cursor?: string };
}

const fetchPage = async (params: Record<string, string>): Promise<ProbeResponse> => {
  const url = new URL(`${getBaseUrl(subdomain as string)}/tickets/${ticketId}/comments`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  console.log(`\nGET ${url.pathname}${url.search}`);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await response.text();
  console.log(`  status: ${response.status} ${response.statusText}`);
  if (!response.ok) {
    // A 400 here is the answer to question 1, so print the body rather than throw.
    console.log(`  body: ${text.slice(0, 500)}`);
    return {};
  }
  const json = JSON.parse(text) as ProbeResponse;
  console.log(`  top-level keys: ${Object.keys(json).join(', ')}`);
  console.log(`  meta: ${JSON.stringify(json.meta ?? null)}`);
  console.log(
    `  comments: ${(json.comments ?? [])
      .map(
        (c) =>
          `{id:${c.id}, author:${c.author_id}, public:${c.public}, at:${c.created_at}, body_len:${c.body?.length ?? 0}}`,
      )
      .join('\n            ')}`,
  );
  console.log(
    `  users side-load: ${json.users ? `${json.users.length} → ids ${json.users.map((u) => u.id).join(', ')}` : 'ABSENT'}`,
  );
  return json;
};

const base = {
  'page[size]': '2',
  sort: '-created_at',
  include: 'users',
  include_inline_images: 'true',
};

const first = await fetchPage(base);
// The system actor (-1) has no user record, so it can never be side-loaded and
// resolveCommentAuthors skips it — counting it here would fake a "NO".
const authorIds = new Set(
  (first.comments ?? []).map((c) => c.author_id).filter((id): id is number => (id ?? 0) > 0),
);
const sideloaded = new Set((first.users ?? []).map((u) => u.id));
console.log(
  `\nQ2 — authors ${[...authorIds].join(', ')} covered by the side-load? ` +
    `${[...authorIds].every((id) => sideloaded.has(id)) ? 'YES' : 'NO (batched show_many fallback fires)'}`,
);

const cursor = first.meta?.after_cursor;
if (first.meta?.has_more && cursor) {
  await fetchPage({ ...base, 'page[after]': cursor });
  console.log(
    '\nQ1 — sort + cursor paging: both pages returned above; check the ids walk backward in time.',
  );
} else {
  console.log(
    '\nQ1 — only one page for this ticket; pick a ticket with more comments to exercise page[after].',
  );
}
