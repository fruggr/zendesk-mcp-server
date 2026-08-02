import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // This package is a binary, not a library: `src/index.ts` exports nothing, so
  // the emitted declaration was `export {}` — ten bytes typing an API that does
  // not exist. Emitting it ran TypeScript's native compiler (tsgo) on every
  // build, and tsgo has no android build, which is what forced a
  // `process.platform !== 'android'` special case here. Turn dts back on only
  // if `src/index.ts` starts exporting a real API, and restore `types` in
  // `package.json` with it.
  dts: false,
  fixedExtension: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
