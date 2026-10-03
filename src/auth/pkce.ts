import { createHash, randomBytes } from 'node:crypto';

export const generateCodeVerifier = (): string => randomBytes(32).toString('base64url');

export const generateCodeChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');
