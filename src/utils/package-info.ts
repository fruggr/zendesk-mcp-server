import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PackageInfo {
  name: string;
  version: string;
}

// Used only if package.json can't be located/parsed (should not happen in a
// published install). Keeps the server bootable rather than throwing.
const FALLBACK: PackageInfo = {
  name: '@fruggr/zendesk-mcp-server',
  version: '0.0.0',
};

/**
 * Read `name`/`version` from the package's own package.json at runtime instead
 * of hardcoding them. Walks up from this module to the nearest package.json,
 * which resolves correctly both when bundled (`dist/index.js` → repo root) and
 * from source/tests (`src/` has no package.json, so the root is found). Reading
 * at runtime (not inlining at build) matters because semantic-release bumps the
 * version into package.json before publishing, after the build step.
 */
// package.json can't change during the process lifetime, and createMcpServer
// (hence this) may run several times (notably across tests) — cache the result.
let cached: PackageInfo | undefined;

export const readPackageInfo = (): PackageInfo => {
  if (cached) return cached;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth++) {
      try {
        // JSON.parse yields `unknown`; validate at runtime rather than asserting.
        const raw: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        if (raw && typeof raw === 'object') {
          const pkg = raw as Partial<PackageInfo>;
          if (typeof pkg.name === 'string' && typeof pkg.version === 'string') {
            cached = { name: pkg.name, version: pkg.version };
            return cached;
          }
        }
      } catch {
        // No readable/valid package.json here — keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta / fs unavailable — fall back below.
  }
  cached = FALLBACK;
  return cached;
};
