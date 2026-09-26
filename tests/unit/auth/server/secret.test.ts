import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  const logger: Logger = {
    debug: (e) => events.push(['debug', e]),
    info: (e) => events.push(['info', e]),
    warn: (e) => events.push(['warn', e]),
    error: (e) => events.push(['error', e]),
    attachServer: vi.fn(),
  };
  return { logger, events };
};

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

  it('does not warn when the store lives elsewhere', () => {
    const { logger, events } = recordingLogger();
    resolveMasterSecret({ configDir: dir, storeUri: storeElsewhere() }, logger);
    expect(events.filter(([level]) => level === 'warn')).toEqual([]);
  });
});
