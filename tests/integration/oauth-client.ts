import { createHash, randomBytes } from 'node:crypto';

/**
 * A scripted MCP OAuth client for the HTTP authorization server: DCR or CIMD
 * registration, the authorization-code flow with PKCE (following every redirect
 * through our server and the MSW-mocked Zendesk), the consent form, and the
 * token endpoint. It is what a real client does, minus the browser.
 */

export const DCR_REDIRECT = 'http://127.0.0.1:9/callback';

export interface TokenResponse {
  status: number;
  body: {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
}

export interface AuthorizeResult {
  /** Present when the flow reached the client's redirect URI with a code. */
  code?: string;
  iss?: string;
  error?: string;
  errorDescription?: string;
  consentShown: boolean;
  hops: string[];
  verifier: string;
}

export type CookieJar = ReturnType<typeof createCookieJar>;

/** A browser's cookies; pass one jar to several `authorize` calls to reuse its session. */
export const createCookieJar = () => {
  const jar = new Map<string, string>();
  return {
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    store: (res: Response) => {
      for (const cookie of res.headers.getSetCookie()) {
        const [pair = ''] = cookie.split(';');
        const index = pair.indexOf('=');
        jar.set(pair.slice(0, index).trim(), pair.slice(index + 1));
      }
    },
  };
};

export const registerDcrClient = async (
  baseUrl: string,
  metadata: Record<string, unknown> = {},
): Promise<{
  status: number;
  body: { client_id?: string; error?: string; error_description?: string };
}> => {
  const res = await fetch(`${baseUrl}/reg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'DCR test client',
      redirect_uris: [DCR_REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...metadata,
    }),
  });
  return { status: res.status, body: await res.json() };
};

export const authorize = async (
  baseUrl: string,
  params: {
    clientId: string;
    redirectUri: string;
    scope?: string;
    /** `null` leaves the parameter out, for the provider's default resource. */
    resource?: string | null;
    deny?: boolean;
    /** Extra authorization request parameters (`prompt`, ...). */
    extra?: Record<string, string>;
    jar?: CookieJar;
  },
): Promise<AuthorizeResult> => {
  const jar = params.jar ?? createCookieJar();
  const verifier = randomBytes(32).toString('base64url');
  const start = new URL(`${baseUrl}/auth`);
  const query: Record<string, string> = {
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: 'code',
    scope: params.scope ?? 'read write',
    state: 'client-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...(params.resource === null ? {} : { resource: params.resource ?? `${baseUrl}/mcp` }),
    ...params.extra,
  };
  for (const [key, value] of Object.entries(query)) start.searchParams.set(key, value);

  const hops: string[] = [];
  let consentShown = false;
  let url = start.toString();
  let method = 'GET';
  for (let i = 0; i < 25; i++) {
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      headers: { cookie: jar.header(), connection: 'close' },
    });
    jar.store(res);
    hops.push(`${method} ${res.status} ${new URL(url).pathname}`);
    const location = res.headers.get('location');
    if (!location) {
      const html = await res.text();
      const target = params.deny
        ? /action="([^"]+\/abort)"/.exec(html)
        : /action="([^"]+\/confirm)"/.exec(html);
      if (!target) return { consentShown, hops, verifier, error: `${res.status} ${html}` };
      consentShown = true;
      url = new URL(target[1] ?? '', url).toString();
      method = 'POST';
      continue;
    }
    const next = new URL(location, url);
    if (next.toString().startsWith(params.redirectUri)) {
      return {
        code: next.searchParams.get('code') ?? undefined,
        iss: next.searchParams.get('iss') ?? undefined,
        error: next.searchParams.get('error') ?? undefined,
        errorDescription: next.searchParams.get('error_description') ?? undefined,
        consentShown,
        hops,
        verifier,
      };
    }
    url = next.toString();
    method = 'GET';
  }
  return { consentShown, hops, verifier, error: 'too many redirects' };
};

export const tokenRequest = async (
  baseUrl: string,
  params: Record<string, string>,
): Promise<TokenResponse> => {
  const res = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', connection: 'close' },
    body: new URLSearchParams({ resource: `${baseUrl}/mcp`, ...params }),
  });
  return { status: res.status, body: await res.json() };
};

export const exchangeCode = (
  baseUrl: string,
  clientId: string,
  redirectUri: string,
  result: AuthorizeResult,
): Promise<TokenResponse> =>
  tokenRequest(baseUrl, {
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code: result.code ?? '',
    code_verifier: result.verifier,
  });

export const refresh = (
  baseUrl: string,
  clientId: string,
  refreshToken: string,
): Promise<TokenResponse> =>
  tokenRequest(baseUrl, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });

/** DCR + authorization + code exchange: the tokens a fresh client ends up with. */
export const signInWithDcr = async (baseUrl: string) => {
  const registration = await registerDcrClient(baseUrl);
  const clientId = registration.body.client_id ?? '';
  const result = await authorize(baseUrl, { clientId, redirectUri: DCR_REDIRECT });
  const tokens = await exchangeCode(baseUrl, clientId, DCR_REDIRECT, result);
  return { clientId, result, tokens };
};

export const callMcp = async (baseUrl: string, accessToken: string | undefined) => {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      connection: 'close',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    }),
  });
  return {
    status: res.status,
    wwwAuthenticate: res.headers.get('www-authenticate'),
    body: await res.text(),
  };
};
