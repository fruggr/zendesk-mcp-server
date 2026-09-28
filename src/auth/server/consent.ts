import { escapeHtml } from '../../utils/html';

export interface ConsentView {
  readonly uid: string;
  readonly clientName?: string | undefined;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly subdomain: string;
}

const hostOf = (uri: string): string => {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
};

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  read: 'Read your Zendesk data',
  write: 'Create and change Zendesk data on your behalf',
};

/**
 * The MCP consent screen, shown once per client that is not trusted (DCR,
 * unknown CIMD, loopback redirects). Names the client, the scopes and where the
 * code goes, per the spec's UI requirements. Every interpolated value is
 * escaped: the client name comes from a document anyone can publish.
 */
export const renderConsentPage = (view: ConsentView): string => {
  const name = escapeHtml(view.clientName ?? view.clientId);
  const scopes = view.scopes
    .map((scope) => `<li>${escapeHtml(SCOPE_LABELS[scope] ?? scope)}</li>`)
    .join('');
  const action = `/interaction/${encodeURIComponent(view.uid)}`;
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Authorize access to Zendesk</title>',
    '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}',
    'code{word-break:break-all}button{font:inherit;padding:.5rem 1.25rem;margin-right:.5rem}</style>',
    '</head><body>',
    `<h1>Allow ${name} to use your Zendesk account?</h1>`,
    `<p><strong>${name}</strong> is asking to act as you on <strong>${escapeHtml(view.subdomain)}.zendesk.com</strong>:</p>`,
    `<ul>${scopes}</ul>`,
    `<p>After you allow it, you are sent back to <strong>${escapeHtml(hostOf(view.redirectUri))}</strong>`,
    ` (<code>${escapeHtml(view.redirectUri)}</code>). Only continue if you started this connection yourself.</p>`,
    `<p>Client id: <code>${escapeHtml(view.clientId)}</code></p>`,
    `<form method="post" action="${action}/confirm" style="display:inline"><button type="submit">Allow</button></form>`,
    `<form method="post" action="${action}/abort" style="display:inline"><button type="submit">Deny</button></form>`,
    '</body></html>',
  ].join('');
};

/** Plain error page for a failed sign-in. ASCII message, escaped. */
export const renderErrorPage = (title: string, detail: string): string =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in failed</title></head><body>' +
  `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`;
