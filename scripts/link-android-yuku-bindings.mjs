// Prepare hook (runs before `npm run build`): make the vendored yuku
// android-arm64 bindings visible to the yuku loader on Android (Termux).
// Upstream publishes no @yuku-{parser,codegen}/binding-android-arm64 package,
// so `tsdown` (our `build`) cannot load its native codegen there.
//
// The loader in yuku's binding.js probes, before any npm lookup, a local path
// inside its own package dir:
//   <pkg>/@yuku-codegen/binding-android-arm64/yuku-codegen.node
// so copying the vendored binding there is enough — no lockfile impact, no
// behavior change on any other platform (instant no-op outside android/arm64).
// See vendor/yuku-android-arm64/README.md for provenance and the exit plan.
import { cpSync, existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'android' && process.arch === 'arm64') {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const vendorRoot = join(root, 'vendor', 'yuku-android-arm64');

  for (const pkg of ['yuku-parser', 'yuku-codegen']) {
    const scope = `@${pkg}`;
    const vendorDir = join(vendorRoot, scope, 'binding-android-arm64');
    const vendorVersion = JSON.parse(
      readFileSync(join(vendorDir, 'package.json'), 'utf8'),
    ).version;

    // pnpm isolated layout: node_modules/.pnpm/yuku-codegen@<v>/node_modules/yuku-codegen
    const candidates = globSync(
      join(root, 'node_modules', '.pnpm', `${pkg}@*`, 'node_modules', pkg),
    );

    for (const pkgDir of candidates) {
      const installedVersion = JSON.parse(
        readFileSync(join(pkgDir, 'package.json'), 'utf8'),
      ).version;
      if (installedVersion !== vendorVersion) {
        console.warn(
          `[android-yuku] ${pkg}@${installedVersion} != vendored binding ${vendorVersion}; ` +
            'skipping — rebuild it from the matching tag (see vendor/yuku-android-arm64/README.md)',
        );
        continue;
      }
      const dest = join(pkgDir, scope, 'binding-android-arm64');
      if (!existsSync(join(dest, `${pkg}.node`))) {
        cpSync(vendorDir, dest, { recursive: true });
        console.log(`[android-yuku] linked ${scope}/binding-android-arm64@${vendorVersion}`);
      }
    }
  }
}
