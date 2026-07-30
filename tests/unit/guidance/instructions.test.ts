import { describe, expect, it } from 'vitest';
import { buildInstructions, topologyResourceUri } from '../../../src/guidance/instructions';
import { makeConfig } from '../../integration/harness';

describe('topologyResourceUri', () => {
  it('builds the URI from the configured scheme (default zendesk-hc)', () => {
    expect(topologyResourceUri(makeConfig())).toBe('zendesk-hc://topology');
    expect(topologyResourceUri(makeConfig({ hcResourceScheme: 'wiki' }))).toBe('wiki://topology');
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
});
