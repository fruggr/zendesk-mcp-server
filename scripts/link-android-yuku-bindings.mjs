// Prepare hook (runs before `npm run build`): make yuku's android-arm64
// bindings available to its loader on Android (Termux). Upstream publishes no
// @yuku-{parser,codegen}/binding-android-arm64 package, so `tsdown` (our
// `build`) cannot load its native codegen there. Instant no-op outside
// android/arm64.
//
// The bindings are NOT committed to this repo: they are downloaded from a
// pinned GitHub release and verified against the SHA-256 hashes below, so git
// history stays lean and any tampering with the release assets is detected.
// Provenance: built from https://github.com/dlecan/yuku/tree/android-arm64-poc
// (yuku v0.6.5 — the version locked in pnpm-lock.yaml — plus a napi-zig fork
// adding the android-arm64 target; build recipe in README-ANDROID-POC.md
// there). Exit plan: delete this script and the `prepare` prefix once upstream
// publishes android-arm64 bindings (tracking issue to be filed against
// yuku-toolchain/yuku).
//
// The loader in yuku's binding.js probes, before any npm lookup, a local path
// inside its own package dir:
//   <pkg>/@yuku-codegen/binding-android-arm64/yuku-codegen.node
// so placing the verified binary there is enough — no lockfile impact.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.6.5';
const RELEASE = 'https://github.com/dlecan/yuku/releases/download/android-arm64-poc-v0.6.5';
const SHA256 = {
  'yuku-parser': '5ecf7add87288a7d2339db2a156d1181ac0773b77c3dd64923b5755276c59bfe',
  'yuku-codegen': 'f1d19b5cac5e45766371514adb327c7b8a632e556fcc141b2d35d40c1a2a2752',
};

async function fetchVerified(pkg) {
  const url = `${RELEASE}/${pkg}.node`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`GET ${url} -> HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== SHA256[pkg]) {
    throw new Error(`sha256 mismatch for ${url}: expected ${SHA256[pkg]}, got ${actual}`);
  }
  return bytes;
}

// pnpm isolated layout: node_modules/.pnpm/<pkg>@<v>/node_modules/<pkg>. With
// another layout (e.g. a consumer's flat node_modules) nothing matches and the
// script is a no-op, like on any non-android platform.
function installedPackageDirs(root, pkg) {
  const store = join(root, 'node_modules', '.pnpm');
  if (!existsSync(store)) return [];
  return readdirSync(store)
    .filter((entry) => entry.startsWith(`${pkg}@`))
    .map((entry) => join(store, entry, 'node_modules', pkg))
    .filter((dir) => existsSync(join(dir, 'package.json')));
}

if (process.platform === 'android' && process.arch === 'arm64') {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));

  for (const pkg of Object.keys(SHA256)) {
    let bytes = null;
    for (const pkgDir of installedPackageDirs(root, pkg)) {
      const installed = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
      if (installed !== VERSION) {
        console.warn(
          `[android-yuku] ${pkg}@${installed} != pinned binding ${VERSION}; skipping — ` +
            'rebuild the binding from the matching upstream tag and update this script',
        );
        continue;
      }
      const dest = join(pkgDir, `@${pkg}`, 'binding-android-arm64', `${pkg}.node`);
      if (existsSync(dest)) continue;
      bytes ??= await fetchVerified(pkg);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
      console.log(`[android-yuku] installed @${pkg}/binding-android-arm64@${VERSION} (verified)`);
    }
  }
}
