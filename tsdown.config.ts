import { defineConfig } from 'tsdown';
import pkg from './package.json' with { type: 'json' };
import { bundleManifest } from './scripts/bundle-manifest.mjs';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  // Nothing debugs the bundle: dev runs tsx on src/, and no code path reads `.stack`.
  sourcemap: false,
  // Binary, not a library: src/index.ts exports nothing, so this only emitted `export {}`.
  dts: false,
  fixedExtension: false,
  // Every dependency is a devDependency, so all of them are inlined and the
  // published package installs nothing. This fails the build if an import ever
  // escapes the bundle. Rationale: docs/decisions/oauth-authorization-server.md (Packaging).
  // onlyBundle false: bundling everything is the point, and dist/sbom.cdx.json
  // lists what went in.
  deps: { onlyImport: [], onlyBundle: false },
  // depd (under Koa, in oidc-provider) builds wrappers with a direct eval. It
  // runs as it did unbundled; the warning only concerns minification, unused here.
  inputOptions: { checks: { eval: false } },
  banner: {
    js: '#!/usr/bin/env node',
  },
  plugins: [bundleManifest({ name: pkg.name, version: pkg.version })],
});
