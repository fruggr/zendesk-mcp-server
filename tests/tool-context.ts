import type {
  ToolCallContext,
  ToolCaller,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../src/tools/definitions';

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

/** A handler as a test calls it: `handler(params, call?)`, acting for `caller`. */
export interface BoundTool extends Omit<ToolDefinition, 'handler'> {
  handler: (params: Record<string, unknown>, call?: ToolCallContext) => Promise<ToolResult>;
}

/** Definitions bound to a test caller, so a test calls `handler(params)` without building a call. */
export const withCaller = (
  tools: readonly ToolDefinition[],
  caller: ToolCaller = testToolContext(),
): BoundTool[] =>
  tools.map((tool) => ({
    ...tool,
    handler: (params, call) => tool.handler(params, { canElicit: false, ...call, caller }),
  }));
