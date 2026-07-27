# Vendored yuku android-arm64 bindings

Upstream `yuku-parser` / `yuku-codegen` (used by `tsdown`) publish no
`binding-android-arm64` package, which breaks `pnpm run build` on Android
(Termux), where node reports `process.platform === "android"`.

These `.node` files were built natively on Termux (Zig 0.16, bionic libc) from
**yuku v0.6.5** — the exact version pinned in `pnpm-lock.yaml`. Sources, build
recipe and provenance:

- Branch: <https://github.com/dlecan/yuku/tree/android-arm64-poc> (see
  `README-ANDROID-POC.md` there)
- Release artifacts: <https://github.com/dlecan/yuku/releases/tag/android-arm64-poc-v0.6.5>

`scripts/link-android-yuku-bindings.mjs` (wired as `postinstall`) copies them
into the loader's local search path inside `node_modules` — on Android only;
it is a no-op everywhere else and touches nothing outside `node_modules`.

**When upgrading `yuku-*` packages**, rebuild the bindings from the matching
upstream tag (the script refuses a version mismatch and prints a warning).
**Delete this directory and the postinstall hook** once upstream publishes
android-arm64 bindings (tracking issue to be filed against
`yuku-toolchain/yuku`).
