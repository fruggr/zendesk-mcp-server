/**
 * Default SUT identity (Q2: hard-coded default + per-call override).
 *
 * The default points at the editable demo SUT (`poc/sut/server.ts`), launched
 * through the locally-installed `tsx` CLI so source edits take effect on the
 * next `sut_reload` with no compile step. Paths are resolved relative to this
 * file so the meta-MCP works regardless of the client's working directory.
 */
import { fileURLToPath } from 'node:url';
import type { SutSpawnParams } from './sut-controller';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Absolute path to the locally-installed tsx CLI (no network, no npx). */
export const TSX_CLI = fileURLToPath(
  new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url),
);

/** Absolute path to the live, editable demo SUT. */
export const DEFAULT_SUT_ENTRY = fileURLToPath(new URL('../sut/server.ts', import.meta.url));

export const defaultSutParams: SutSpawnParams = {
  command: process.execPath, // the same node binary running the meta-MCP
  args: [TSX_CLI, DEFAULT_SUT_ENTRY],
  cwd: repoRoot,
};

export const paths = { here, repoRoot };
