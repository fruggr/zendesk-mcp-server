import { setupServer } from 'msw/node';
import { beforeAll, afterAll, afterEach } from 'vitest';
import { handlers } from './msw-handlers';

export const mswServer = setupServer(...handlers);

// 'warn' instead of 'error': OAuth and integration tests make requests
// to local Express servers that MSW doesn't need to intercept
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
