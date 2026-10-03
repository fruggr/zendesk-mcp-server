import { describe, expect, it, vi } from 'vitest';
import { createFileStore } from '../../../../src/auth/server/file-store';
import { isStartupError, STARTUP_DOCS } from '../../../../src/utils/startup-error';

// A read-only filesystem, as in a hardened container: every directory exists and
// none is writable. Mocked because root bypasses a chmod-based one.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  accessSync: () => {
    throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
  },
}));

describe('createFileStore on a read-only filesystem', () => {
  it('stops at startup with the fix and the docs link', () => {
    let error: unknown;
    try {
      createFileStore('/tmp/store.json');
    } catch (err) {
      error = err;
    }
    expect(isStartupError(error)).toBe(true);
    expect(error).toMatchObject({
      message:
        'Cannot write the OAuth store at /tmp/store.json (EROFS). Point OAUTH_STORE (or --oauth-store) ' +
        `at a writable directory, such as a mounted volume. See ${STARTUP_DOCS.secretAndStore}`,
      cause: { code: 'EROFS' },
    });
  });
});
