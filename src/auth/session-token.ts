import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * In HTTP mode the bearer token belongs to the incoming MCP session, not to
 * the server process. We can't capture it in a closure at startup, but we
 * also don't want to thread a token argument through 37 tool handlers.
 *
 * The HTTP transport wraps each tool invocation with `runWithSessionToken`,
 * which puts the per-session token in async-local storage. The tools'
 * `getToken` closure (built in `index.ts`) reads it back via
 * `getSessionToken`. Stdio mode never enters this store and uses its own
 * static / OAuth-store-backed closure instead.
 */
const sessionTokenStore = new AsyncLocalStorage<string>();

export const runWithSessionToken = <T>(token: string, fn: () => T): T =>
  sessionTokenStore.run(token, fn);

export const getSessionToken = (): string => {
  const token = sessionTokenStore.getStore();
  if (!token) {
    throw new Error(
      'No Zendesk OAuth token available for this MCP session. ' +
        'Ensure the MCP client sent an Authorization: Bearer <token> header.',
    );
  }
  return token;
};
