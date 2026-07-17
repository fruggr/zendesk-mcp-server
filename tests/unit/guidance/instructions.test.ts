import { describe, expect, it } from 'vitest';
import {
  articleResourcesEnabled,
  buildInstructions,
  TOPOLOGY_RESOURCE_URI,
} from '../../../src/guidance/instructions';
import { makeConfig } from '../../integration/harness';

describe('buildInstructions', () => {
  it('returns a blob mentioning the subdomain and the topology URI when help_center is active', () => {
    const text = buildInstructions(makeConfig({ subdomain: 'acme' }));
    expect(text).toBeDefined();
    expect(text).toContain('acme');
    expect(text).toContain(TOPOLOGY_RESOURCE_URI);
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

describe('articleResourcesEnabled', () => {
  it('is enabled by default and when help_center is explicitly included', () => {
    expect(articleResourcesEnabled(makeConfig())).toBe(true);
    expect(articleResourcesEnabled(makeConfig({ namespaces: ['help_center'] }))).toBe(true);
  });

  it('is disabled when help_center is filtered out', () => {
    expect(articleResourcesEnabled(makeConfig({ namespaces: ['tickets'] }))).toBe(false);
  });

  it('is disabled when the feature flag is off, independently of topology', () => {
    expect(articleResourcesEnabled(makeConfig({ articleResources: false }))).toBe(false);
    // Independent toggles: topology off does not disable article resources.
    expect(articleResourcesEnabled(makeConfig({ topology: false }))).toBe(true);
  });
});
