import { getBaseUrl, getHelpCenterBaseUrl } from '../constants.js';
import {
  deadlineSignal,
  describeTarget,
  fetchWithRetry,
  type HttpMethod,
  MAY_HAVE_APPLIED_NOTE,
  REFUSED_NOTE,
  REQUEST_TIMEOUT_MS,
  TRANSFER_TIMEOUT_MS,
  writeNote,
} from './retry';

export class ZendeskApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
    // Decides whether a failed write is told it may have taken effect; the
    // per-status wording is otherwise unchanged. Exposed like ZendeskNetworkError's
    // so a caller can branch on it rather than parse the message.
    public readonly method: HttpMethod,
  ) {
    super(ZendeskApiError.buildMessage(status, statusText, body, method));
    this.name = 'ZendeskApiError';
  }

  private static buildMessage(
    status: number,
    statusText: string,
    body: string,
    method: HttpMethod,
  ): string {
    switch (status) {
      case 401:
        return 'Authentication failed. Your Zendesk token may be expired or invalid. Re-authenticate to get a new token.';
      case 403:
        return 'Permission denied. Your Zendesk account does not have access to this resource.';
      case 404:
        return `Resource not found. Please verify the ID is correct. (${statusText})`;
      case 422:
        return `Validation error: ${body}`;
      case 429:
        // A 429 was refused outright, so a write is safe to send again later.
        return `Rate limit exceeded. Please wait before making more requests.${writeNote(method, REFUSED_NOTE)}`;
      default: {
        const message = `Zendesk API error ${status}: ${statusText}. ${body}`;
        // A 5xx is the dangerous one: the write is not replayed here precisely
        // because it may have applied, so say so rather than let the caller retry.
        return status >= 500 ? `${message}${writeNote(method, MAY_HAVE_APPLIED_NOTE)}` : message;
      }
    }
  }
}

export interface ZendeskRequestOptions {
  method?: HttpMethod;
  body?: unknown;
  params?: Record<string, string>;
}

// token is a per-user OAuth 2.1 PKCE access token (the only auth mode)
const buildAuthHeader = (token: string): string => `Bearer ${token}`;

const buildUrl = (base: string, path: string, params?: Record<string, string>): string => {
  const url = new URL(`${base}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
};

// Every request in this module goes through here: each attempt gets its own
// deadline, transient failures are retried per the method's policy (`retry.ts`),
// and a failure with no response at all is wrapped with the method and path
// instead of surfacing a bare `fetch failed`. The signal is built inside the
// thunk so every attempt starts its deadline fresh.
const performFetch = (
  method: HttpMethod,
  url: string,
  init: Omit<RequestInit, 'method' | 'signal'>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> =>
  fetchWithRetry(
    () => fetch(url, { ...init, method, signal: deadlineSignal(timeoutMs) }),
    method,
    describeTarget(url),
  );

const executeRequest = async <T>(
  url: string,
  token: string,
  options: ZendeskRequestOptions = {},
): Promise<T> => {
  const { method = 'GET', body } = options;

  const headers: Record<string, string> = {
    Authorization: buildAuthHeader(token),
    Accept: 'application/json',
  };

  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const init: Omit<RequestInit, 'method'> = { headers };
  if (body) {
    init.body = JSON.stringify(body);
  }

  const response = await performFetch(method, url, init);

  if (!response.ok) {
    const responseBody = await response.text();
    throw new ZendeskApiError(response.status, response.statusText, responseBody, method);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
};

export const zendeskGet = <T>(
  subdomain: string,
  token: string,
  path: string,
  params?: Record<string, string>,
): Promise<T> => {
  const url = buildUrl(getBaseUrl(subdomain), path, params);
  return executeRequest<T>(url, token);
};

export const zendeskPost = <T>(
  subdomain: string,
  token: string,
  path: string,
  body: unknown,
): Promise<T> => {
  const url = buildUrl(getBaseUrl(subdomain), path);
  return executeRequest<T>(url, token, { method: 'POST', body });
};

export const zendeskPut = <T>(
  subdomain: string,
  token: string,
  path: string,
  body: unknown,
): Promise<T> => {
  const url = buildUrl(getBaseUrl(subdomain), path);
  return executeRequest<T>(url, token, { method: 'PUT', body });
};

export const helpCenterGet = <T>(
  subdomain: string,
  token: string,
  path: string,
  params?: Record<string, string>,
): Promise<T> => {
  const url = buildUrl(getHelpCenterBaseUrl(subdomain), path, params);
  return executeRequest<T>(url, token);
};

export const helpCenterPost = <T>(
  subdomain: string,
  token: string,
  path: string,
  body: unknown,
): Promise<T> => {
  const url = buildUrl(getHelpCenterBaseUrl(subdomain), path);
  return executeRequest<T>(url, token, { method: 'POST', body });
};

export const helpCenterPut = <T>(
  subdomain: string,
  token: string,
  path: string,
  body: unknown,
): Promise<T> => {
  const url = buildUrl(getHelpCenterBaseUrl(subdomain), path);
  return executeRequest<T>(url, token, { method: 'PUT', body });
};

export const helpCenterDelete = <T>(subdomain: string, token: string, path: string): Promise<T> => {
  const url = buildUrl(getHelpCenterBaseUrl(subdomain), path);
  return executeRequest<T>(url, token, { method: 'DELETE' });
};

export const fetchZendeskBinary = async (
  subdomain: string,
  token: string,
  contentUrl: string,
): Promise<{ data: Buffer; contentType: string }> => {
  const expectedHost = `${subdomain}.zendesk.com`;
  const headers: Record<string, string> = {};
  if (new URL(contentUrl).hostname === expectedHost) {
    headers['Authorization'] = buildAuthHeader(token);
  }
  const response = await performFetch('GET', contentUrl, { headers }, TRANSFER_TIMEOUT_MS);
  if (!response.ok) {
    const body = await response.text();
    throw new ZendeskApiError(response.status, response.statusText, body, 'GET');
  }
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const arrayBuffer = await response.arrayBuffer();
  return { data: Buffer.from(arrayBuffer), contentType };
};

// Zendesk Uploads API: POST /uploads?filename=... with the raw file bytes as the
// body and Content-Type set to the file's MIME type. `executeRequest` always
// JSON-encodes, so this builds its own request (like helpCenterUpload) while
// still sharing `performFetch`. Pass `uploadToken` to aggregate another file
// under an existing upload token.
export const zendeskUpload = async <T>(
  subdomain: string,
  token: string,
  filename: string,
  data: Buffer,
  contentType: string,
  uploadToken?: string,
): Promise<T> => {
  const params: Record<string, string> = { filename };
  if (uploadToken) params['token'] = uploadToken;
  const url = buildUrl(getBaseUrl(subdomain), '/uploads', params);
  const response = await performFetch(
    'POST',
    url,
    {
      headers: { Authorization: buildAuthHeader(token), 'Content-Type': contentType },
      body: data,
    },
    TRANSFER_TIMEOUT_MS,
  );

  if (!response.ok) {
    const responseBody = await response.text();
    throw new ZendeskApiError(response.status, response.statusText, responseBody, 'POST');
  }

  return response.json() as Promise<T>;
};

export const helpCenterUpload = async <T>(
  subdomain: string,
  token: string,
  path: string,
  formData: FormData,
): Promise<T> => {
  const url = buildUrl(getHelpCenterBaseUrl(subdomain), path);
  const response = await performFetch(
    'POST',
    url,
    { headers: { Authorization: buildAuthHeader(token) }, body: formData },
    TRANSFER_TIMEOUT_MS,
  );

  if (!response.ok) {
    const responseBody = await response.text();
    throw new ZendeskApiError(response.status, response.statusText, responseBody, 'POST');
  }

  return response.json() as Promise<T>;
};
