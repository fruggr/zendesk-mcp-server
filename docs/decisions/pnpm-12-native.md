# pnpm 12 on Android: pinned for the native CLI

> **Build documentation, not user documentation.** This records why the
> `packageManager` pin moved to pnpm 12, why it names that exact version, and what
> the affected device needed along the way. Nothing here changes how the MCP
> server behaves for a client.

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-09-10, revised 2026-09-16 |
| **Applied in** | [#281](https://github.com/fruggr/zendesk-mcp-server/pull/281) |
| **Question** | pnpm 12 rewrites the CLI in Rust and ships it as a native binary per host, including Android since 12.4.0. Worth pinning? |
| **Answer** | **Yes.** Start-up drops from 4.1 s to under 0.1 s on the affected device, and no platform needs an install route of its own. |

Measured on the affected device (Termux, `android-arm64`, 6 cores), pnpm 11.25.0
through Corepack against pnpm 12.4.1 native, on this repo's own manifest. The pinned
12.4.2 starts in the same time.

## What actually changed

pnpm 11 and older are a JavaScript CLI: Corepack downloads one tarball and Node
runs it. pnpm 12 publishes `@pnpm/exe.<target>` packages as optional dependencies
of `pnpm`, and the `pnpm` bin is the host's native executable — no Node start-up
per call. 12.4.0 added `android-arm64` and `android-x64` to that matrix
([pnpm/pnpm#14660](https://github.com/pnpm/pnpm/pull/14660)), which is what makes
this device eligible at all.

| | pnpm 11.25.0 | pnpm 12.4.1 |
| --- | --- | --- |
| `pnpm --version`, warm | 4.1 s | 0.1 s |
| `install --lockfile-only`, 873 entries | 24.8 s | 7.7 s |
| `install --frozen-lockfile`, warm | — | 1.3 s |

Both versions verify the lockfile against the supply-chain policies, and on a slow
connection that check dominates a cold run (20.7 s of the 24.8 s above, and 55 s
once here). It is network-bound and cached afterwards, so the start-up row is what
measures the rewrite.

## Why the pin names 12.4.2 exactly

Each earlier version fails here in its own way, which is worth knowing before
anyone moves the pin to a rounder number.

- **12.3.4 and older** publish no Android binary at all. No route installs them
  on this device.
- **12.4.0** publishes the binary but cannot use it: every registry request
  crashed, because pnpm asked the Android platform verifier for a system trust
  store it cannot reach without a JVM
  ([pnpm/pnpm#14777](https://github.com/pnpm/pnpm/issues/14777)), and imports
  failed with `Permission denied (os error 13)` on a filesystem that refuses hard
  links, since `packageImportMethod: auto` had stopped falling back to copying
  ([pnpm/pnpm#14780](https://github.com/pnpm/pnpm/issues/14780)). No hard link can
  be created anywhere on this device, so that second one broke every fresh
  install.
- **12.4.1** fixes both: bundled CA roots on Android, and the copy fallback
  restored. A cold install and a `pnpm dlx` both work with no environment
  variables and no import-method setting, but the version has to come from npm,
  because Corepack still refuses the platform.
- **12.4.2** vendors the fixed downloader, so Corepack installs it here too.

## Corepack

The wrapper's Corepack entry (`bin/pnpm.mjs`) downloads the executable through the
`get-pnpm` copy it vendors. Up to 12.4.1 that copy was `get-pnpm@0.0.3`, which
refuses any platform outside `darwin`/`linux`/`win32`, so Corepack answered
`Sorry! pnpm does not provide a pre-built binary for android` even though the
package exists on npm
([pnpm/pnpm#14679](https://github.com/pnpm/pnpm/issues/14679)). 12.4.2 vendors
`get-pnpm@0.0.4`, which carries the fix from
[pnpm/get.pnpm.io#59](https://github.com/pnpm/get.pnpm.io/pull/59) and accepts
`android-arm64` and `android-x64` for major 12 and up. Both `pnpm` and `pnpx` run
from the Corepack shims here again, with no environment variables and no
import-method setting; the upstream issue stayed open, the fix travelled with the
vendored copy.

npm installs the same binary, and remains a way to have pnpm outside any checkout:
`npm i -g --prefix ~/.local/share/pnpm pnpm@VERSION` resolves the optional
dependency for the host, and the package's own install script links the binary over
the placeholder bin. Installing into pnpm's own home (whose `bin/` pnpm asks you to
keep first on `PATH`) rather than over `$PREFIX/bin/pnpm` leaves Corepack's shim in
place, so deleting `~/.local/share/pnpm/bin/pnpm*` is the whole rollback. The
version it names matters little, since a 12.4.x binary honours a project's pin and
fetches the pinned version itself. A checkout pinned to pnpm 11 is the exception and
fails with `ERR_PNPM_PNPM_ENGINE_NO_NATIVE_BINARY`, because no pnpm 11 binary can
exist here; `pmOnFail: ignore` skips that switch, through `--pm-on-fail=ignore` on
the command or `PNPM_CONFIG_PM_ON_FAIL=ignore` in the environment, and an install
run that way writes the lockfile in the pinned major's shape rather than pnpm 12's.
Treat it as a bridge rather than a destination: with it set, the pin no longer
decides which pnpm runs.

## What the pin bump implies for the repo

- **The lockfile records pnpm itself.** pnpm 12 writes a first YAML document
  carrying `packageManagerDependencies` and the `@pnpm/exe.*` entries, ahead of
  the existing one, which it leaves untouched. `pnpm install --frozen-lockfile`
  fails outright on a lockfile without it
  (`ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE`), so a pin bump has to
  refresh `pnpm-lock.yaml` in the same commit — Renovate's pnpm PRs included.
- **CI needed no change.** `pnpm/action-setup@v6` resolves to v6.1.0, which
  supports pnpm 12 and installs the native executable; its `standalone` input is
  a no-op there.
- **The settings survived.** pnpm 12 fails a command outright on a
  `pnpm-workspace.yaml` key it does not recognise, when the project pins a
  version it satisfies. `allowBuilds`, `minimumReleaseAge`, `overrides` and
  `minimumReleaseAgeStrict` are all still recognised, and the age gate still
  fails closed — a version published the day before is refused with
  `ERR_PNPM_NO_MATURE_MATCHING_VERSION`, which is the invariant
  [`dependency-automerge.md`](dependency-automerge.md) rests on. That file's
  warning against weakening the gate now covers the two hatches v12 adds,
  `minimumReleaseAgeExclude` and approving a pick at an interactive prompt.
- **An ignored build script is now an error.** `ERR_PNPM_IGNORED_BUILDS` replaces
  the warning pnpm 11 printed, which the repo does not feel because
  `pnpm-workspace.yaml` whitelists what needs building. A throwaway `pnpm dlx`
  has no such file, so a package with a build script needs
  `--allow-build=<pkg>` there (`pnpm dlx --allow-build=esbuild tsx …`).
