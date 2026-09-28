import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Logger, silentLogger } from '../../utils/logger';
import { MIN_SECRET_BYTES, parseSecretList } from './keys';

export const MASTER_SECRET_FILE_NAME = 'oauth-master-secret';

export type MasterSecretSource = 'env' | 'file-flag' | 'persisted' | 'generated' | 'ephemeral';

export interface MasterSecretInput {
  /** `OAUTH_MASTER_SECRET`. */
  readonly value?: string | undefined;
  /** `--oauth-master-secret-file`. */
  readonly file?: string | undefined;
  /** Where an auto-generated secret is persisted. */
  readonly configDir: string;
  /** `--oauth-store`: `memory://` keeps an auto-generated secret in memory too. */
  readonly storeUri: string;
}

export interface MasterSecret {
  readonly value: string;
  readonly source: MasterSecretSource;
}

const isWindows = process.platform === 'win32';

const readSecretFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(
      `Cannot read the OAuth master secret file (${(err as NodeJS.ErrnoException).code}).`,
      { cause: err },
    );
  }
};

const writeSecretFile = (path: string, value: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
  if (!isWindows) chmodSync(tmp, 0o600);
  renameSync(tmp, path);
};

const storeDirectory = (storeUri: string): string | undefined =>
  storeUri.startsWith('file:') ? dirname(fileURLToPath(storeUri)) : undefined;

/**
 * Resolve the AS master secret: explicit value, then `--oauth-master-secret-file`,
 * then the persisted file in the config dir, then a fresh secret written there.
 * The library's public `DEV_KEYSTORE` fallback is thereby never reachable.
 * Rationale and custody rules: `docs/decisions/oauth-authorization-server.md`.
 */
export const resolveMasterSecret = (
  input: MasterSecretInput,
  logger: Logger = silentLogger,
): MasterSecret => {
  const validated = (value: string, source: MasterSecretSource): MasterSecret => {
    parseSecretList(value);
    return { value, source };
  };

  if (input.value) return validated(input.value, 'env');
  if (input.file) {
    const fromFlag = readSecretFile(input.file);
    if (!fromFlag) throw new Error('The OAuth master secret file is missing or empty.');
    return validated(fromFlag, 'file-flag');
  }

  const generate = () => randomBytes(MIN_SECRET_BYTES).toString('base64');
  if (input.storeUri.startsWith('memory:')) {
    logger.info('oauth_master_secret_ephemeral', {
      hint: 'memory:// store: the secret and every grant are lost on restart.',
    });
    return { value: generate(), source: 'ephemeral' };
  }

  const path = join(input.configDir, MASTER_SECRET_FILE_NAME);
  const persisted = readSecretFile(path);
  const secret = persisted ? validated(persisted, 'persisted') : undefined;
  const result = secret ?? { value: generate(), source: 'generated' as const };
  if (!secret) {
    writeSecretFile(path, result.value);
    logger.info('oauth_master_secret_generated', { path });
  }
  if (storeDirectory(input.storeUri) === resolve(input.configDir)) {
    logger.warn('oauth_master_secret_beside_store', {
      hint:
        'The auto-generated master secret sits next to the file store: fine locally, but a ' +
        'deployment should supply OAUTH_MASTER_SECRET from a secret manager instead.',
    });
  }
  return result;
};
