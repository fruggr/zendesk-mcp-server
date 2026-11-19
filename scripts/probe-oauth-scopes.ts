#!/usr/bin/env tsx
/**
 * Read-only probe for #360: which Zendesk OAuth scope each endpoint the tools
 * call really needs, for an agent and for an end user.
 *
 *   Q1. Does the authorize step accept the requested scopes, and what does
 *       Zendesk report as granted (token response, `/oauth/tokens/current`)?
 *   Q2. Sign-in: what does `GET /users/me` answer with a token that lacks
 *       `users:read` — the user, the anonymous user, or a 403?
 *   Q3. For every GET a namespace relies on: 200 or 403 under this scope?
 *   Q4. Does `<resource>:write` alone also grant `<resource>:read`?
 *
 * The server always asks for `read write` (`src/auth/oauth-scopes.ts`), so this
 * probe runs its own PKCE sign-in with the scope given in `--scope`: it prints
 * the authorize URL, a human signs in, and the token stays in memory — never
 * printed, never persisted. Sample ids (an article, a ticket…) are discovered
 * with the persisted token `live-auth.ts` resolves, so a narrow token's 403 is
 * not mistaken for an empty tenant.
 *
 * GETs only (plus the OAuth code exchange). It prints scopes, roles, ids,
 * status codes and Zendesk's error code — never a subject, a body or a name.
 *
 * Usage:
 *   pnpm tsx scripts/probe-oauth-scopes.ts --scope "hc:read requests:read"
 */
import { createServer } from 'node:http';
import open from 'open';
import { generateCodeChallenge, generateCodeVerifier } from '../src/auth/pkce';
import { helpCenterGet, ZendeskApiError, zendeskGet } from '../src/client/zendesk-api';
import { DEFAULT_CALLBACK_PORT, getOAuthUrls } from '../src/constants';
import { missingTokenHelp, resolveLiveSubdomain, resolveLiveToken } from './live-auth';

type Json = Record<string, unknown>;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};

const scope =
  argValue('--scope')?.trim() || fail('Missing --scope "<space-separated Zendesk scopes>".');
const subdomain =
  resolveLiveSubdomain() ??
  fail('No subdomain: set ZENDESK_SUBDOMAIN, or run from a checkout whose .mcp.json declares one.');
const oauthClientId = process.env['ZENDESK_OAUTH_CLIENT_ID']?.trim() || `${subdomain}_zendesk`;
const callbackPort = Number(process.env['OAUTH_CALLBACK_PORT'] || DEFAULT_CALLBACK_PORT);

// ---------------------------------------------------------------------------
// Sample ids, discovered with the broad persisted token.

const broad = resolveLiveToken(subdomain) ?? fail(missingTokenHelp(subdomain));
const broadToken = await broad.getToken();

const firstId = async (label: string, run: () => Promise<Json>, key: string) => {
  try {
    const list = (await run())[key];
    const id = Array.isArray(list) ? (list[0] as Json | undefined)?.['id'] : undefined;
    return typeof id === 'number' ? id : undefined;
  } catch (error) {
    console.log(`discovery ${label} FAILED: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
};

const one = { per_page: '1' };
const samples = {
  article: await firstId(
    'article',
    () => helpCenterGet(subdomain, broadToken, '/articles', one),
    'articles',
  ),
  ticket: await firstId(
    'ticket',
    () => zendeskGet(subdomain, broadToken, '/tickets', one),
    'tickets',
  ),
  user: await firstId('user', () => zendeskGet(subdomain, broadToken, '/users', one), 'users'),
  organization: await firstId(
    'organization',
    () => zendeskGet(subdomain, broadToken, '/organizations', one),
    'organizations',
  ),
  view: await firstId('view', () => zendeskGet(subdomain, broadToken, '/views', one), 'views'),
  group: await firstId('group', () => zendeskGet(subdomain, broadToken, '/groups', one), 'groups'),
};
broad.dispose();
console.log(`broad token: ${broad.origin}`);
console.log(`samples: ${JSON.stringify(samples)}`);

// ---------------------------------------------------------------------------
// Narrow sign-in: a PKCE flow of our own, so the requested scope is ours.

interface TokenResponse {
  access_token: string;
  scope?: string;
  token_type?: string;
  expires_in?: number;
}

const signIn = (): Promise<TokenResponse> => {
  const { authorizeUrl, tokenUrl } = getOAuthUrls(subdomain);
  const verifier = generateCodeVerifier();
  const redirectUri = `http://localhost:${callbackPort}/callback`;
  const url = `${authorizeUrl}?${new URLSearchParams({
    response_type: 'code',
    client_id: oauthClientId,
    redirect_uri: redirectUri,
    scope,
    code_challenge: generateCodeChallenge(verifier),
    code_challenge_method: 'S256',
  })}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('sign-in timed out (5 min)'));
    }, 5 * 60_000);
    const server = createServer(async (req, res) => {
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Probe signed in. Close this tab.');
      clearTimeout(timer);
      server.close();
      const error = params.get('error');
      if (error) {
        reject(new Error(`authorize answered error=${error} (${params.get('error_description')})`));
        return;
      }
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: params.get('code') ?? '',
          client_id: oauthClientId,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }).toString(),
      });
      if (!response.ok) {
        // The error body is Zendesk's OAuth error object, which holds no secret.
        reject(new Error(`token exchange ${response.status}: ${await response.text()}`));
        return;
      }
      resolve((await response.json()) as TokenResponse);
    });
    server.listen(callbackPort, () => {
      console.error(`\nSign in to Zendesk with the account under test:\n${url}\n`);
      open(url).catch(() => {});
    });
  });
};

console.log(`\nrequested scope: "${scope}"`);
let granted: TokenResponse;
try {
  granted = await signIn();
} catch (error) {
  console.log(`Q1 sign-in FAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(0);
}
const token = granted.access_token;
console.log(
  `Q1 token response: scope=${JSON.stringify(granted.scope ?? null)} ` +
    `token_type=${granted.token_type} expires_in=${granted.expires_in ?? 'absent'}`,
);

// ---------------------------------------------------------------------------
// The matrix: one GET per endpoint a tool, the sign-in or the topology hits.

const describeError = (error: unknown): string => {
  if (!(error instanceof ZendeskApiError)) {
    return `ERROR ${error instanceof Error ? error.message : String(error)}`;
  }
  // Zendesk's own error code and boilerplate, which tells a scope denial from a
  // role denial; never user content.
  let detail = '';
  try {
    const body = JSON.parse(error.body) as Json;
    const code = typeof body['error'] === 'string' ? body['error'] : JSON.stringify(body['error']);
    const description = String(body['description'] ?? '').slice(0, 140);
    detail = `${code}${description ? ` — ${description}` : ''}`;
  } catch {
    detail = error.body.slice(0, 80);
  }
  return `${error.status} ${detail}`;
};

const describeOk = (body: Json): string =>
  Object.entries(body)
    .filter(([key]) => !/^(next|previous)_page$|^count$|^meta$|^links$/.test(key))
    .map(([key, value]) => (Array.isArray(value) ? `${key}[${value.length}]` : key))
    .sort((a, b) => a.localeCompare(b))
    .join(', ');

const row = async (
  area: string,
  label: string,
  run: (() => Promise<Json>) | undefined,
  extra?: (body: Json) => string,
) => {
  if (!run) {
    console.log(`${area.padEnd(12)} ${label.padEnd(48)} SKIPPED (no sample id)`);
    return;
  }
  try {
    const body = await run();
    console.log(
      `${area.padEnd(12)} ${label.padEnd(48)} 200 ${extra ? extra(body) : describeOk(body)}`,
    );
  } catch (error) {
    console.log(`${area.padEnd(12)} ${label.padEnd(48)} ${describeError(error)}`);
  }
};

const api = (path: string, params?: Record<string, string>) => () =>
  zendeskGet<Json>(subdomain, token, path, params);
const hc = (path: string, params?: Record<string, string>) => () =>
  helpCenterGet<Json>(subdomain, token, path, params);
const when = <T>(id: T | undefined, build: (id: T) => () => Promise<Json>) =>
  id === undefined ? undefined : build(id);

console.log('\nQ1/Q2/Q3 — status per endpoint');

await row('token', 'GET /oauth/tokens/current', api('/oauth/tokens/current'), (body) => {
  const t = body['token'] as Json | undefined;
  return `scopes=${JSON.stringify(t?.['scopes'] ?? null)}`;
});
await row('sign-in', 'GET /users/me', api('/users/me'), (body) => {
  const user = body['user'] as Json | undefined;
  return `id=${typeof user?.['id'] === 'number' ? 'number' : JSON.stringify(user?.['id'])} role=${user?.['role']}`;
});

// help_center, the topology resource and the initialize instructions.
await row('help_center', 'GET /help_center/locales', hc('/locales'));
await row('help_center', 'GET /help_center/categories', hc('/categories', one));
await row('help_center', 'GET /help_center/sections', hc('/sections', one));
await row('help_center', 'GET /help_center/articles', hc('/articles', one));
await row(
  'help_center',
  'GET /help_center/articles/{id}',
  when(samples.article, (id) => hc(`/articles/${id}`)),
);
await row(
  'help_center',
  'GET /help_center/articles/{id}/translations',
  when(samples.article, (id) => hc(`/articles/${id}/translations`)),
);
await row(
  'help_center',
  'GET /help_center/articles/{id}/attachments',
  when(samples.article, (id) => hc(`/articles/${id}/attachments`)),
);
await row(
  'help_center',
  'GET /help_center/articles/search',
  hc('/articles/search', { query: 'a', per_page: '1' }),
);
await row('help_center', 'GET /help_center/articles/labels', hc('/articles/labels', one));
await row('help_center', 'GET /help_center/user_segments', hc('/user_segments'));
await row('help_center', 'GET /guide/permission_groups', api('/guide/permission_groups'));
await row(
  'help_center',
  'GET /guide/content_tags',
  api('/guide/content_tags', { 'page[size]': '1' }),
);
await row('help_center', 'GET /brands', api('/brands'));

// requests (end-user surface).
await row('requests', 'GET /requests', api('/requests', one));
await row('requests', 'GET /requests/search', api('/requests/search', { query: '*' }));
await row('requests', 'GET /ticket_forms', api('/ticket_forms'));
await row('requests', 'GET /ticket_fields', api('/ticket_fields'));
const ownRequest = await zendeskGet<Json>(subdomain, token, '/requests', one)
  .then((body) => (body['requests'] as Json[] | undefined)?.[0]?.['id'] as number | undefined)
  .catch(() => undefined);
await row(
  'requests',
  'GET /requests/{own id}',
  when(ownRequest, (id) => api(`/requests/${id}`)),
);
await row(
  'requests',
  'GET /requests/{own id}/comments',
  when(ownRequest, (id) => api(`/requests/${id}/comments`)),
);

// tickets (agent surface), views, macros, SLA.
await row('tickets', 'GET /tickets', api('/tickets', one));
await row(
  'tickets',
  'GET /tickets/{id}',
  when(samples.ticket, (id) => api(`/tickets/${id}`)),
);
await row(
  'tickets',
  'GET /tickets/{id}/comments',
  when(samples.ticket, (id) => api(`/tickets/${id}/comments`)),
);
await row(
  'tickets',
  'GET /tickets/{id}/audits',
  when(samples.ticket, (id) => api(`/tickets/${id}/audits`)),
);
await row(
  'tickets',
  'GET /tickets/{id}/incidents',
  when(samples.ticket, (id) => api(`/tickets/${id}/incidents`)),
);
await row(
  'tickets',
  'GET /tickets/show_many',
  when(samples.ticket, (id) => api('/tickets/show_many', { ids: String(id) })),
);
await row('tickets', 'GET /views', api('/views', one));
await row(
  'tickets',
  'GET /views/count_many',
  when(samples.view, (id) => api('/views/count_many', { ids: String(id) })),
);
await row(
  'tickets',
  'GET /views/{id}/execute',
  when(samples.view, (id) => api(`/views/${id}/execute`, one)),
);
await row('tickets', 'GET /macros/active', api('/macros/active', one));
await row('tickets', 'GET /slas/policies', api('/slas/policies'));
await row(
  'tickets',
  'GET /groups/show_many',
  when(samples.group, (id) => api('/groups/show_many', { ids: String(id) })),
);

// users and organizations.
await row(
  'users',
  'GET /users/{id}',
  when(samples.user, (id) => api(`/users/${id}`)),
);
await row(
  'users',
  'GET /users/show_many',
  when(samples.user, (id) => api('/users/show_many', { ids: String(id) })),
);
await row('users', 'GET /organizations', api('/organizations', one));
await row(
  'users',
  'GET /organizations/{id}',
  when(samples.organization, (id) => api(`/organizations/${id}`)),
);

// search spans several resources: one row per result type.
for (const type of ['ticket', 'user', 'organization', 'group']) {
  await row(
    'search',
    `GET /search?query=type:${type}`,
    api('/search', { query: `type:${type}`, per_page: '1' }),
  );
}

console.log('\ndone');
process.exit(0);
