import { describe, expect, it } from 'vitest';
import {
  articleResourceEnabled,
  articleResourceUri,
  articleResourceUriTemplate,
  buildInstructions,
  promotedArticlesEnabled,
  topologyResourceUri,
} from '../../../src/guidance/instructions';
import { makeConfig } from '../../integration/harness';

describe('topologyResourceUri', () => {
  it('builds the URI from the configured scheme (default zendesk-hc)', () => {
    expect(topologyResourceUri(makeConfig())).toBe('zendesk-hc://topology');
    expect(topologyResourceUri(makeConfig({ hcResourceScheme: 'wiki' }))).toBe('wiki://topology');
  });
});

describe('article resource URIs', () => {
  it('build the template and per-id URI from the configured scheme, in lockstep with topology', () => {
    expect(articleResourceUriTemplate(makeConfig())).toBe('zendesk-hc://article/{id}');
    expect(articleResourceUri(makeConfig(), 5001)).toBe('zendesk-hc://article/5001');

    const wiki = makeConfig({ hcResourceScheme: 'wiki' });
    expect(articleResourceUriTemplate(wiki)).toBe('wiki://article/{id}');
    expect(articleResourceUri(wiki, 5001)).toBe('wiki://article/5001');
  });

  it('carries a brand dimension in multi/all mode, resolved like the tools', () => {
    // With several brands the article id alone does not say WHICH Help Center
    // holds it, so the URI names the brand exactly like a tool call's
    // brand_id — by id or subdomain, idiom and allow-list shared.
    const multi = makeConfig({ brandIds: ['support', '360001234567'] });
    expect(articleResourceUriTemplate(multi)).toBe('zendesk-hc://brands/{brand}/articles/{id}');
    expect(articleResourceUri(multi, 5001, 'support')).toBe(
      'zendesk-hc://brands/support/articles/5001',
    );

    const all = makeConfig({ brandIds: ['all'] });
    expect(articleResourceUriTemplate(all)).toBe('zendesk-hc://brands/{brand}/articles/{id}');
    expect(articleResourceUri(all, 5001, '360001234567')).toBe(
      'zendesk-hc://brands/360001234567/articles/5001',
    );

    // The custom scheme flows into the brand-scoped form too.
    const wiki = makeConfig({ brandIds: ['all'], hcResourceScheme: 'wiki' });
    expect(articleResourceUriTemplate(wiki)).toBe('wiki://brands/{brand}/articles/{id}');
  });

  it('keeps the unscoped URI in unset and single-brand modes', () => {
    // Unset and single-lock servers address exactly one Help Center, so a brand
    // segment would be noise — the URI shape stays what a single-brand account
    // has always seen.
    expect(articleResourceUriTemplate(makeConfig())).toBe('zendesk-hc://article/{id}');
    expect(articleResourceUriTemplate(makeConfig({ brandIds: ['support'] }))).toBe(
      'zendesk-hc://article/{id}',
    );
    expect(articleResourceUri(makeConfig({ brandIds: ['support'] }), 5001)).toBe(
      'zendesk-hc://article/5001',
    );
  });
});

describe('buildInstructions', () => {
  it('returns a blob mentioning the subdomain and the topology URI when help_center is active', () => {
    const config = makeConfig({ subdomain: 'acme' });
    const text = buildInstructions(config);
    expect(text).toBeDefined();
    expect(text).toContain('acme');
    expect(text).toContain(topologyResourceUri(config));
  });

  it('names the brand restriction when one is configured', () => {
    const text = buildInstructions(makeConfig({ subdomain: 'acme', brandIds: ['424242'] }));
    expect(text).toContain('424242');
  });

  it('names all brands when the allow-list is "all"', () => {
    const text = buildInstructions(makeConfig({ subdomain: 'acme', brandIds: ['all'] }));
    expect(text).toContain('all brands');
  });

  it('names the allowed brands when several are configured', () => {
    const text = buildInstructions(
      makeConfig({ subdomain: 'acme', brandIds: ['424242', '777777'] }),
    );
    expect(text).toContain('424242');
    expect(text).toContain('777777');
  });

  it('mentions no brand when none is configured', () => {
    expect(buildInstructions(makeConfig({ subdomain: 'acme' }))).not.toContain('brand');
  });

  it('cites the custom scheme in the blob when one is configured', () => {
    const text = buildInstructions(makeConfig({ hcResourceScheme: 'wiki' }));
    expect(text).toContain('wiki://topology');
    expect(text).not.toContain('zendesk-hc://');
  });

  it('returns the blob when the namespace filter explicitly includes help_center', () => {
    expect(buildInstructions(makeConfig({ namespaces: ['help_center'] }))).toBeDefined();
  });

  it('returns undefined when help_center is filtered out', () => {
    expect(buildInstructions(makeConfig({ namespaces: ['tickets'] }))).toBeUndefined();
    expect(buildInstructions(makeConfig({ namespaces: ['users'] }))).toBeUndefined();
  });

  it('returns undefined when the topology feature is disabled', () => {
    expect(buildInstructions(makeConfig({ topology: false }))).toBeUndefined();
  });

  it('says the topology IDs belong to ONE brand in multi mode, naming the first', () => {
    // The topology resource pins to the first allowed brand; without this
    // sentence an agent reads its section ids as valid for every allowed brand.
    const text = buildInstructions(
      makeConfig({ subdomain: 'acme', brandIds: ['support', 'docs'] }),
    );
    expect(text).toContain(
      'The topology describes brand support only; for another brand, use list_categories / list_sections with its brand_id.',
    );
  });

  it("says the topology IDs belong to ONE brand in 'all' mode, naming the account default", () => {
    const text = buildInstructions(makeConfig({ subdomain: 'acme', brandIds: ['all'] }));
    expect(text).toContain(
      'The topology describes the account default brand only; for another brand, use list_categories / list_sections with its brand_id.',
    );
  });

  it('adds no topology-brand caveat in unset or single-brand mode', () => {
    expect(buildInstructions(makeConfig({ subdomain: 'acme' }))).not.toContain(
      'The topology describes',
    );
    expect(
      buildInstructions(makeConfig({ subdomain: 'acme', brandIds: ['support'] })),
    ).not.toContain('The topology describes');
  });
});

describe('articleResourceEnabled (read-by-id)', () => {
  it('is on whenever help_center is active, regardless of the promoted flag or topology', () => {
    expect(articleResourceEnabled(makeConfig())).toBe(true);
    expect(articleResourceEnabled(makeConfig({ namespaces: ['help_center'] }))).toBe(true);
    // Read-by-id is NOT gated by the promoted pre-listing flag nor by topology.
    expect(articleResourceEnabled(makeConfig({ promotedArticles: false }))).toBe(true);
    expect(articleResourceEnabled(makeConfig({ topology: false }))).toBe(true);
  });

  it('is off only when help_center is filtered out', () => {
    expect(articleResourceEnabled(makeConfig({ namespaces: ['tickets'] }))).toBe(false);
  });
});

describe('promotedArticlesEnabled (resource pre-listing)', () => {
  it('is enabled by default and when help_center is explicitly included', () => {
    expect(promotedArticlesEnabled(makeConfig())).toBe(true);
    expect(promotedArticlesEnabled(makeConfig({ namespaces: ['help_center'] }))).toBe(true);
  });

  it('is disabled when help_center is filtered out', () => {
    expect(promotedArticlesEnabled(makeConfig({ namespaces: ['tickets'] }))).toBe(false);
  });

  it('is disabled when the flag is off, independently of topology', () => {
    expect(promotedArticlesEnabled(makeConfig({ promotedArticles: false }))).toBe(false);
    // Independent toggles: topology off does not disable the promoted listing.
    expect(promotedArticlesEnabled(makeConfig({ topology: false }))).toBe(true);
  });
});
