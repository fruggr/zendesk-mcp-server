# Running Biome on Android/Termux: a shim, not a pnpm setting

> **Build documentation, not user documentation.** This records a toolchain
> decision and the checks behind it, for maintainers. Nothing here affects how
> the MCP server behaves for a client. User-facing docs live one level up in
> [`docs/`](../).

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-07-29 |
| **Applied in** | [#191](https://github.com/fruggr/zendesk-mcp-server/pull/191) |
| **Question** | Biome does not run in native Termux, where `process.platform` is `android`. Fix it in pnpm's install config, or in a wrapper? |
| **Answer** | A wrapper: `scripts/biome.mjs`, fetching the musl build on android only. Every install-side option either costs all other contributors hundreds of MB or is silently ignored. |

Measured on the affected device (Termux, `android-arm64`, 6 cores), pnpm 11.15
and 11.17. Do not compare these numbers with
[`lint-tooling.md`](lint-tooling.md), whose stage tables come from a shared
x86-64 container.

## Why Biome breaks there

Two independent causes, both from `platform === 'android'`:

1. Biome's launcher (`@biomejs/biome/bin/biome`) maps `process.platform` to a
   binary package and has entries for win32, darwin, linux and linux-musl only.
   On android it exits 1 with "doesn't ship with prebuilt binaries for your
   platform yet". Its musl probe is moot anyway: it shells out to
   `ldd --version`, and Termux ships no `ldd`.
2. There is nothing to point it at. The `@biomejs/cli-*` packages are optional
   dependencies of `@biomejs/biome`, and pnpm applies each one's own
   `os`/`cpu`/`libc` gate, so on android all eight are skipped at install time.

## Which binary works

| binary | on this device |
| --- | --- |
| `@biomejs/cli-linux-arm64` (glibc) | `cannot execute: required file not found` — dynamically linked, no interpreter on bionic |
| `@biomejs/cli-linux-arm64-musl` | works; statically linked, so bionic is irrelevant |

## Options rejected

| Option | Why not |
| --- | --- |
| `supportedArchitectures` in `pnpm-workspace.yaml` | Installs the musl CLI on android, but the file is versioned, so it applies to everyone. The lockfile has 45 arm64 platform entries (tsgo, rolldown, lightningcss, esbuild, yuku), and every contributor and CI job would pull the linux-arm64 and linux-arm64-musl set of all of them. |
| Same key in `.npmrc`, or as `--config.supportedArchitectures…` | Silently ignored. pnpm reads it from `pnpm-workspace.yaml` only, and there is no local, unversioned way to set it. |
| `@biomejs/cli-linux-arm64-musl` as a direct devDependency | Works — pnpm applies the platform gate to transitive and optional dependencies, not to direct ones. But it is 21 MB downloaded on every platform, and Renovate would bump it and `@biomejs/biome` in separate PRs, leaving a window where the launcher runs a binary from another version with nothing reporting the mismatch. |
| `packageExtensions`, as done for the yuku bindings | The gate reads the target package's own manifest, so grafting the official tarball changes nothing. It would need a repacked tarball declaring `os: [android]`, hosted and re-cut on every Biome bump. |
| `pnpm patch` on the launcher | Would make `biome` work for any caller, including hardcoded `node_modules/.bin/biome` paths and IDE extensions. But it still needs the binary installed by one of the rows above, and the patch has to be revalidated whenever Renovate bumps Biome. The shim covers every caller in this repo without either cost. |
| Fetching at install time (`prepare`), plus a `node_modules/.bin/biome` redirect | The one install-side option that costs other platforms nothing, and the only one that would make a bypassing caller *work* instead of fail. Not taken for now: the redirect mutates `node_modules` on every install (pnpm recreates its own shim, so `prepare` would have to re-patch), and the lazy fetch is still needed as the `--ignore-scripts` fallback. Worth revisiting if the fetch-inside-a-hook cost below starts to bite. |

## Consequences

- Every Biome caller in the repo goes through the shim: the `check` and
  `check:fix` scripts, the `PostToolUse` hook in `.claude/settings.json`, the
  pre-commit job in `lefthook.yml`. `scripts/bench-lint-tooling.mjs` asks it for
  the binary path (`--print-binary`) instead, so its samples don't include the
  shim's own start-up. A caller that bypasses all of that keeps working
  everywhere except Termux, where it stops linting silently.
- The fetch is lazy, so the first lint after a Biome bump pulls 21 MB from
  inside whichever caller runs first — possibly the per-edit hook. An offline
  device fails there rather than at install time. That is the price of not
  provisioning at install time (see the last rejected option).
- lefthook has no android build either, so on Termux the pre-commit hook is not
  installed at all: repointing `lefthook.yml` serves the other platforms and
  will take effect here if lefthook itself becomes runnable. Until then,
  formatting and import sorting stay CI-only on that device.
- The hooks invoke `node scripts/biome.mjs` rather than a pnpm script: `pnpm`
  costs 3.7 s of start-up on this device against 0.37 s for `node`, and the
  per-edit hook itself runs in 0.31 s.
- A direct `node_modules/.bin/biome` from outside the repo (an IDE extension,
  an ad-hoc `pnpm exec biome`) still fails on Termux. `BIOME_BINARY` is the
  escape hatch: `export BIOME_BINARY=$(node scripts/biome.mjs --print-binary)`,
  so the cache path is derived in one place rather than retyped. The shim
  honors that variable when it is already set.
- The binary is cached per version and arch under `XDG_CACHE_HOME`, outside the
  project, so `pnpm install` does not evict it and a Renovate bump fetches its
  own on the next run.

## When to retire it

When Biome publishes an android build. The shim then has nothing left to do and
should be deleted outright, with the callers going back to `biome` directly —
not kept as a pass-through.
