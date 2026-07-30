import { defineConfig } from 'tsdown';

// TypeScript 7 emits d.ts through its native compiler (tsgo), and Microsoft
// publishes no @typescript/typescript-android-arm64 — on Termux the dts step
// dies with "Unable to resolve @typescript/typescript-android-arm64". Skip
// d.ts emission there: releases are built by CI on linux, and on-device dev
// (tsx, tests, MCP runtime) never reads dist/*.d.ts. Retire the gate if
// upstream ships an android build (https://github.com/microsoft/typescript-go).
const dtsAvailable = process.platform !== 'android';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: dtsAvailable,
  fixedExtension: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
