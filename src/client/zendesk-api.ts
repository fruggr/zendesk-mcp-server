import { getBaseUrl, getHelpCenterBaseUrl } from '../constants.js';

export class ZendeskApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(ZendeskApiError.buildMessage(status, statusText, body));
    this.name = 'ZendeskApiError';
  }

  private static buildMessage(status: number, statusText: string, body: string): string {
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
        return 'Rate limit exceeded. Please wait before making more requests.';
      default:
        return `Zendesk API error ${status}: ${statusText}. ${body}`;
    }
  }
}

export interface ZendeskRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  params?: Record<string, string>;
}

const buildUrl = (base: string, path: string, params?: Record<string, string>): string => {
  const url = new URL(`${base}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
};

const executeRequest = async <T>(url: string, token: string, options: ZendeskRequestOptions = {}): Promise<T> => {
  const { method = 'GET', body } = options;

  // token is either a Bearer OAuth token or a "Basic xxx" string (stdio API token mode)
  const authorization = token.startsWith('Basic ') ? token : `Bearer ${token}`;
  const headers: Record<string, string> = {
    Authorization: authorization,
    Accept: 'application/json',
  };

  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const init: RequestInit = { method, headers };
  if (body) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);

  if (!response.ok) {
    const responseBody = await response.text();
    throw new ZendeskApiError(response.status, response.statusText, responseBody);
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
