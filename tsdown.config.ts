import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  // Nothing debugs the bundle: dev runs tsx on src/, and no code path reads `.stack`.
  sourcemap: false,
  // Binary, not a library: src/index.ts exports nothing, so this only emitted `export {}`.
  dts: false,
  fixedExtension: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
