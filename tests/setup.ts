// Run the suite against what actually ships: the entrypoint compiles zod schemas on their
// first synchronous parse (src/index.ts), so the tests do too. Setup files evaluate before
// the test modules, which is what makes the schemas they build compile — the same ordering
// constraint the entrypoint has. Deliberate trade-off: nothing here covers the uncompiled
// path anymore. See docs/decisions/zod-compile.md.
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
