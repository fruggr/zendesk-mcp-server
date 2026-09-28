import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../../../src/utils/html';

describe('escapeHtml', () => {
  it('escapes every character that can break out of text or an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('escapes every occurrence, not only the first', () => {
    expect(escapeHtml('<<>>&&""\'\'')).toBe('&lt;&lt;&gt;&gt;&amp;&amp;&quot;&quot;&#39;&#39;');
  });

  it('escapes the ampersand first, so entities are not double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves plain text alone', () => {
    expect(escapeHtml('Claude Code')).toBe('Claude Code');
  });
});
