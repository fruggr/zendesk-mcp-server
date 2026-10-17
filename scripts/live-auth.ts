/**
 * Credentials for the live scripts (`mcp-live.ts`, `probe-*.ts`), resolved the
 * way the stdio server resolves them, so an agent never has to read, print or
 * export a token: the script fetches it itself. Handing a token to an agent
 * invites it to `curl` Zendesk directly, which the session security classifier
 * blocks — see `docs/live-testing.md` (Probes).
 *
 * Subdomain: `ZENDESK_SUBDOMAIN`, else the `zendesk-local` entry of the
 * committed `.mcp.json`. Token: `ZENDESK_OAUTH_TOKEN` when set, else the token
 * file the stdio server persisted on its first sign-in, through the server's
 * own token store (silent refresh included). A script never opens the browser
 * flow: with no persisted token it fails with the step that creates one.
 */
import { readFileSync } from 'node:fs';
import { requestedScope } from '../src/auth/oauth-scopes';
import { loadToken, resolveTokenPath } from '../src/auth/token-persistence';
import { createTokenStore } from '../src/auth/token-store';

const nonEmptyEnv = (name: string): string | undefined => {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== '' ? raw : undefined;
};

const subdomainFromMcpConfig = (): string | undefined => {
  try {
    const raw: unknown = JSON.parse(readFileSync(new URL('../.mcp.json', import.meta.url), 'utf8'));
    const env = (raw as { mcpServers?: Record<string, { env?: Record<string, string> }> })
      .mcpServers?.['zendesk-local']?.env;
    return env?.['ZENDESK_SUBDOMAIN'] || undefined;
  } catch {
    return undefined;
  }
};

export const resolveLiveSubdomain = (): string | undefined =>
  nonEmptyEnv('ZENDESK_SUBDOMAIN') ?? subdomainFromMcpConfig();

export interface LiveTokenSource {
  /** Where the token came from, safe to print (never the token itself). */
  origin: string;
  getToken: () => Promise<string>;
  dispose: () => void;
}

/**
 * The token source for `subdomain`. The `.mcp.json` server runs read-write, so
 * its token file is tried first; a read-write grant also covers read-only use.
 * Returns `undefined` when neither the environment nor a persisted file holds a
 * credential; `missingTokenHelp` says how to get one.
 */
export const resolveLiveToken = (subdomain: string): LiveTokenSource | undefined => {
  const envToken = nonEmptyEnv('ZENDESK_OAUTH_TOKEN');
  if (envToken) {
    return { origin: 'ZENDESK_OAUTH_TOKEN', getToken: async () => envToken, dispose: () => {} };
  }
  const oauthClientId = nonEmptyEnv('ZENDESK_OAUTH_CLIENT_ID') ?? `${subdomain}_zendesk`;
  for (const readOnly of [false, true]) {
    const path = resolveTokenPath({ subdomain, oauthClientId, scope: requestedScope(readOnly) });
    if (!loadToken(path)) continue;
    const store = createTokenStore({ subdomain, oauthClientId, readOnly });
    return {
      origin: `persisted token store (${readOnly ? 'read' : 'read write'} scope)`,
      getToken: store.getToken,
      dispose: store.dispose,
    };
  }
  return undefined;
};

export const missingTokenHelp = (subdomain: string): string =>
  `No Zendesk credential for "${subdomain}". Sign in once through the zendesk-local MCP ` +
  'server (call any of its tools in a Claude Code session and follow the sign-in link); ' +
  'the token it persists is then picked up here. Do not copy the token by hand.';
