import { describe, expect, it } from 'vitest';
import { renderConsentPage, renderErrorPage } from '../../../../src/auth/server/consent';

describe('renderConsentPage', () => {
  const view = {
    uid: 'uid/1',
    clientName: 'Claude Code',
    clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
    redirectUri: 'http://127.0.0.1:53123/callback',
    scopes: ['read', 'write'],
    subdomain: 'acme',
  };

  it('names the client, the account, the scopes and the redirect target', () => {
    expect(renderConsentPage(view)).toMatchInlineSnapshot(
      `"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize access to Zendesk</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}code{word-break:break-all}button{font:inherit;padding:.5rem 1.25rem;margin-right:.5rem}</style></head><body><h1>Allow Claude Code to use your Zendesk account?</h1><p><strong>Claude Code</strong> is asking to act as you on <strong>acme.zendesk.com</strong>:</p><ul><li>Read your Zendesk data</li><li>Create and change Zendesk data on your behalf</li></ul><p>After you allow it, you are sent back to <strong>127.0.0.1:53123</strong> (<code>http://127.0.0.1:53123/callback</code>). Only continue if you started this connection yourself.</p><p>Client id: <code>https://claude.ai/oauth/claude-code-client-metadata</code></p><form method="post" action="/interaction/uid%2F1/confirm" style="display:inline"><button type="submit">Allow</button></form><form method="post" action="/interaction/uid%2F1/abort" style="display:inline"><button type="submit">Deny</button></form></body></html>"`,
    );
  });

  it('escapes a hostile client name and falls back to the client id', () => {
    const html = renderConsentPage({
      ...view,
      clientName: '<script>alert(1)</script>',
      scopes: ['custom'],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<li>custom</li>');
    const unnamed = renderConsentPage({ ...view, clientName: undefined });
    expect(unnamed).toContain(
      '<h1>Allow https://claude.ai/oauth/claude-code-client-metadata to use',
    );
  });

  it('shows an unparseable redirect as is', () => {
    expect(renderConsentPage({ ...view, redirectUri: 'weird' })).toContain(
      'sent back to <strong>weird</strong>',
    );
  });
});

describe('renderErrorPage', () => {
  it('escapes both fields', () => {
    expect(renderErrorPage('Sign-in <failed>', 'a & b')).toBe(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in failed</title></head><body><h1>Sign-in &lt;failed&gt;</h1><p>a &amp; b</p></body></html>',
    );
  });
});
