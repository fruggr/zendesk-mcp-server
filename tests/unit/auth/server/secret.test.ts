import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MASTER_SECRET_FILE_NAME, resolveMasterSecret } from '../../../../src/auth/server/secret';
import type { Logger } from '../../../../src/utils/logger';

const VALID = Buffer.alloc(32, 9).toString('base64');
const SHORT = Buffer.alloc(16, 9).toString('base64');

const recordingLogger = () => {
  const events: [string, string][] = [];
  const entries: [string, string, unknown][] = [];
  const record = (level: string) => (e: string, fields?: unknown) => {
    events.push([level, e]);
    entries.push([level, e, fields]);
  };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    attachServer: vi.fn(),
  };
  return { logger, events, entries };
};

const modeOf = (path: string) => (statSync(path).mode % 0o1000).toString(8);
const onWindows = process.platform === 'win32';

describe('resolveMasterSecret', () => {
  let dir: string;
  const storeElsewhere = () => pathToFileURL(join(dir, 'volume', 'store.json')).href;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zmcp-secret-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('prefers the explicit value and writes nothing', () => {
    const result = resolveMasterSecret({
      value: VALID,
      configDir: dir,
      storeUri: storeElsewhere(),
    });
    expect(result).toEqual({ value: VALID, source: 'env' });
    expect(() => statSync(join(dir, MASTER_SECRET_FILE_NAME))).toThrow();
  });

  it('rejects a short explicit value', () => {
    expect(() =>
      resolveMasterSecret({ value: SHORT, configDir: dir, storeUri: storeElsewhere() }),
    ).toThrow('at least 32 bytes');
  });

  it('reads --oauth-master-secret-file, trimming the trailing newline', () => {
    const file = join(dir, 'provided');
    writeFileSync(file, `${VALID}\n`);
    expect(resolveMasterSecret({ file, configDir: dir, storeUri: storeElsewhere() })).toEqual({
      value: VALID,
      source: 'file-flag',
    });
  });

  it('fails on a missing or empty --oauth-master-secret-file instead of generating', () => {
    const file = join(dir, 'provided');
    expect(() => resolveMasterSecret({ file, configDir: dir, storeUri: storeElsewhere() })).toThrow(
      'The OAuth master secret file is missing or empty.',
    );
    writeFileSync(file, '  \n');
    expect(() => resolveMasterSecret({ file, configDir: dir, storeUri: storeElsewhere() })).toThrow(
      'missing or empty',
    );
  });

  it('generates, persists with owner-only permissions, and reuses the secret on the next start', () => {
    const { logger, events } = recordingLogger();
    const first = resolveMasterSecret({ configDir: dir, storeUri: storeElsewhere() }, logger);
    expect(first.source).toBe('generated');
    expect(Buffer.from(first.value, 'base64')).toHaveLength(32);
    const path = join(dir, MASTER_SECRET_FILE_NAME);
    expect(readFileSync(path, 'utf8')).toBe(`${first.value}\n`);
    if (process.platform !== 'win32')
      expect((statSync(path).mode % 0o1000).toString(8)).toBe('600');
    expect(events).toContainEqual(['info', 'oauth_master_secret_generated']);

    const second = resolveMasterSecret({ configDir: dir, storeUri: storeElsewhere() });
    expect(second).toEqual({ value: first.value, source: 'persisted' });
  });

  it('refuses a persisted file that was tampered down to a short secret', () => {
    writeFileSync(join(dir, MASTER_SECRET_FILE_NAME), SHORT);
    expect(() => resolveMasterSecret({ configDir: dir, storeUri: storeElsewhere() })).toThrow(
      'at least 32 bytes',
    );
  });

  it('keeps an auto-generated secret in memory only for a memory:// store', () => {
    const { logger, events } = recordingLogger();
    const result = resolveMasterSecret({ configDir: dir, storeUri: 'memory://' }, logger);
    expect(result.source).toBe('ephemeral');
    expect(() => statSync(join(dir, MASTER_SECRET_FILE_NAME))).toThrow();
    expect(events).toContainEqual(['info', 'oauth_master_secret_ephemeral']);
  });

  it('warns when the auto-generated secret shares a directory with the file store', () => {
    const { logger, events } = recordingLogger();
    resolveMasterSecret(
      { configDir: dir, storeUri: pathToFileURL(join(dir, 'oauth-store.json')).href },
      logger,
    );
    expect(events).toContainEqual(['warn', 'oauth_master_secret_beside_store']);
  });

  it('reads the flag file with surrounding whitespace trimmed', () => {
    const file = join(dir, 'provided');
    writeFileSync(file, ` \t${VALID} \n`);
    expect(resolveMasterSecret({ file, configDir: dir, storeUri: storeElsewhere() }).value).toBe(
      VALID,
    );
  });

  it('names the error code when a secret file exists but cannot be read', () => {
    let error: unknown;
    try {
      resolveMasterSecret({ file: dir, configDir: dir, storeUri: storeElsewhere() });
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({
      message: 'Cannot read the OAuth master secret file (EISDIR).',
      cause: { code: 'EISDIR' },
    });
  });

  it('logs the ephemeral secret with its restart hint', () => {
    const { logger, entries } = recordingLogger();
    resolveMasterSecret({ configDir: dir, storeUri: 'memory://' }, logger);
    expect(entries).toEqual([
      [
        'info',
        'oauth_master_secret_ephemeral',
        { hint: 'memory:// store: the secret and every grant are lost on restart.' },
      ],
    ]);
  });

  it('logs where it wrote a generated secret, creating the config dir, and only once', () => {
    const configDir = join(dir, 'a', 'b');
    const path = join(configDir, MASTER_SECRET_FILE_NAME);
    const first = recordingLogger();
    const generated = resolveMasterSecret({ configDir, storeUri: storeElsewhere() }, first.logger);
    expect(first.entries).toEqual([['info', 'oauth_master_secret_generated', { path }]]);

    const second = recordingLogger();
    writeFileSync(path, `${generated.value}\n\n`);
    expect(resolveMasterSecret({ configDir, storeUri: storeElsewhere() }, second.logger)).toEqual({
      value: generated.value,
      source: 'persisted',
    });
    expect(second.entries).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(`${generated.value}\n\n`);
  });

  it('warns, with a hint, when the secret shares a directory with the file store', () => {
    const { logger, entries } = recordingLogger();
    resolveMasterSecret(
      { configDir: dir, storeUri: pathToFileURL(join(dir, 'oauth-store.json')).href },
      logger,
    );
    expect(entries.filter(([level]) => level === 'warn')).toEqual([
      [
        'warn',
        'oauth_master_secret_beside_store',
        {
          hint:
            'The auto-generated master secret sits next to the file store: fine locally, but a ' +
            'deployment should supply OAUTH_MASTER_SECRET from a secret manager instead.',
        },
      ],
    ]);
  });

  it('persists a generated secret for a non-file store without comparing directories', () => {
    const { logger, events } = recordingLogger();
    const result = resolveMasterSecret(
      { configDir: dir, storeUri: 'redis://localhost:6379' },
      logger,
    );
    expect(result.source).toBe('generated');
    expect(events).toEqual([['info', 'oauth_master_secret_generated']]);
  });

  // POSIX modes only mean something off Windows; the Windows branch is exercised by pretending.
  describe.skipIf(onWindows)('file modes', () => {
    // A crashed write leaves its temp file behind, and writeFileSync keeps an existing file's mode.
    const leaveStaleTempFile = () => {
      const tmp = `${join(dir, MASTER_SECRET_FILE_NAME)}.${process.pid}.tmp`;
      writeFileSync(tmp, '');
      chmodSync(tmp, 0o644);
    };

    it('resets a stale temp file to owner-only before renaming it', () => {
      leaveStaleTempFile();
      resolveMasterSecret({ configDir: dir, storeUri: storeElsewhere() });
      expect(modeOf(join(dir, MASTER_SECRET_FILE_NAME))).toBe('600');
    });

    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const loadAsWindows = async () => {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      try {
        vi.resetModules();
        return (await import('../../../../src/auth/server/secret')).resolveMasterSecret;
      } finally {
        if (platform) Object.defineProperty(process, 'platform', platform);
      }
    };

    it('relies on the creation mode alone on Windows', async () => {
      (await loadAsWindows())({ configDir: dir, storeUri: storeElsewhere() });
      expect(modeOf(join(dir, MASTER_SECRET_FILE_NAME))).toBe('600');
    });

    it('skips the POSIX chmod on Windows', async () => {
      leaveStaleTempFile();
      (await loadAsWindows())({ configDir: dir, storeUri: storeElsewhere() });
      expect(modeOf(join(dir, MASTER_SECRET_FILE_NAME))).toBe('644');
    });
  });

  it('does not warn when the store lives elsewhere', () => {
    const { logger, events } = recordingLogger();
    resolveMasterSecret({ configDir: dir, storeUri: storeElsewhere() }, logger);
    expect(events.filter(([level]) => level === 'warn')).toEqual([]);
  });
});
