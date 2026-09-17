// Run the suite against what actually ships: the entrypoint compiles zod schemas on
// their first synchronous parse (src/index.ts), and setup files evaluate before the test
// modules, so the schemas they build compile the same way. Nothing covers the uncompiled
// path. See docs/decisions/zod-compile.md.
import 'zod/compile';

import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { handlers } from './msw-handlers';

export const mswServer = setupServer(...handlers);

// 'warn' instead of 'error': OAuth and integration tests make requests
// to local Express servers that MSW doesn't need to intercept
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
