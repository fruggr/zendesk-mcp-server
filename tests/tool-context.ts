import type { ToolContext } from '../src/tools/definitions';

/**
 * A tool context for tests that never select a brand. Resolving one rejects
 * instead of quietly building a `https://.zendesk.com` URL, so a test that
 * starts using brands fails at its cause.
 */
export const testToolContext = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  subdomain: 'testsubdomain',
  getToken: () => 'test-token',
  resolveBrandSubdomain: (idOrSubdomain) =>
    Promise.reject(new Error(`unexpected brand lookup in a brandless test: ${idOrSubdomain}`)),
  ...overrides,
});
