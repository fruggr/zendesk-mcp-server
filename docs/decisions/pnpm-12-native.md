# pnpm 12 on Android: pinned for the native CLI, provisioned outside Corepack

> **Build documentation, not user documentation.** This records why the
> `packageManager` pin moved to a pnpm line whose Android support is still
> incomplete upstream, and what that costs on the one device it affects. Nothing
> here changes how the MCP server behaves for a client.

| | |
| --- | --- |
| **Status** | Decided and applied |
| **Date** | 2026-09-10 |
| **Applied in** | [#281](https://github.com/fruggr/zendesk-mcp-server/pull/281) |
| **Question** | pnpm 12 rewrites the CLI in Rust and ships it as a native binary per host. 12.4.0 is the first release to publish an Android one. Worth pinning, when three of its Android paths are broken upstream? |
| **Answer** | **Yes.** Start-up drops from ~4 s to ~0.2 s on the affected device, and all three gaps have a local answer that costs the other platforms nothing. |

Measured on the affected device (Termux, `android-arm64`, 6 cores), pnpm 11.25.0
through Corepack against pnpm 12.4.0 native, on this repo's own manifest.

## What actually changed

pnpm 11 and older are a JavaScript CLI: Corepack downloads one tarball and Node
runs it. pnpm 12 publishes `@pnpm/exe.<target>` packages as optional dependencies
of `pnpm`, and the `pnpm` bin is the host's native executable — no Node start-up
per call. 12.4.0 added `android-arm64` and `android-x64` to that matrix
([pnpm/pnpm#14660](https://github.com/pnpm/pnpm/pull/14660)), which is what makes
this device eligible at all. 12.3.4, still npm's `latest` when this landed, ships
no Android binary and cannot be installed here by any route.

| | pnpm 11.25.0 | pnpm 12.4.0 |
| --- | --- | --- |
| `pnpm --version`, warm | 4.1 s | 0.2 s |
| `install --lockfile-only`, 873 entries | 24.8 s | 6.3 s |
| the same, re-run | — | 0.16 s |

Both versions verify the lockfile against the supply-chain policies on every
install, and on a slow connection that check dominates the total (20.7 s of the
24.8 s above, 6 s of the 6.3 s, and 55 s on a cold run). It is network-bound, so
read the start-up row rather than the totals for what the rewrite itself buys.

## The three Android gaps

**A fresh install cannot materialise `node_modules`.** No hard link can be created
anywhere on this device: `link()` returns `EPERM` in `$HOME`, in `$PREFIX/tmp`, in
the pnpm store and inside the worktrees alike, and every store file sits at
`nlink 1`. pnpm 11 coped, because `packageImportMethod: auto` falls back to
copying; pnpm 12 stops at the refused link and fails with `failed to import …
Permission denied (os error 13)`, for `pnpm add`, `pnpm install` and `pnpm dlx`
alike ([pnpm/pnpm#14782](https://github.com/pnpm/pnpm/issues/14782)). Naming the
method explicitly is the answer, and it belongs in the machine's own config rather
than in this repo, because it describes the filesystem and not the project:
`pnpm config set packageImportMethod copy --global`. With that in place a cold
install of the 766 packages here takes 21 s against a cold store and 6.4 s against
a warm one.

This gap hides easily, so it is worth knowing how to see it: an install that finds
`node_modules` already materialised skips the import step and passes whatever the
method. It only surfaces on a fresh checkout, which is exactly what the
`post-switch` hook in `.config/wt.toml` produces on every new worktree.

**Corepack cannot provision the binary.** The wrapper's Corepack entry
(`bin/pnpm.mjs`) downloads the executable through the `get-pnpm` copy it vendors,
and 12.4.0 vendors `get-pnpm@0.0.3`, which refuses any platform outside
`darwin`/`linux`/`win32` — so Corepack reports `Sorry! pnpm does not provide a
pre-built binary for android` even though the package exists on npm
([pnpm/pnpm#14679](https://github.com/pnpm/pnpm/issues/14679)).
[pnpm/get.pnpm.io#59](https://github.com/pnpm/get.pnpm.io/pull/59) fixed that, and
`get-pnpm@0.0.4` carries the fix, so what is left is a pnpm release vendoring the
newer copy. The way in meanwhile is npm, naming the version `packageManager` pins:
`npm i -g --prefix ~/.local/share/pnpm pnpm@VERSION`. npm resolves the optional
dependency for the host, and the package's own install script links the binary
over the placeholder bin.

Installing into pnpm's own home (`~/.local/share/pnpm`, whose `bin/` pnpm asks you
to keep first on `PATH`) rather than over `$PREFIX/bin/pnpm` is deliberate: npm
puts the binary at `<prefix>/bin/pnpm` and leaves Corepack's shim in place, so
deleting `~/.local/share/pnpm/bin/pnpm*` is the whole rollback. Note that the
shadowing is machine-wide, so a checkout still pinned to pnpm 11 fails with
`ERR_PNPM_PNPM_ENGINE_NO_NATIVE_BINARY`, because pnpm 12 honours the pin itself
and no pnpm 11 binary can exist here. `pmOnFail: ignore` skips that switch, and it
does not need the project's own config: `--pm-on-fail=ignore` on the command and
`PNPM_CONFIG_PM_ON_FAIL=ignore` in the environment both work, for `pnpm exec` and
`pnpm install` alike, and an install run that way writes the lockfile in the
pinned major's shape rather than pnpm 12's. Treat it as a bridge while the pin
spreads rather than a destination: with it set, the pin no longer decides which
pnpm runs.

**Every registry request panics.** The Rust CLI delegates TLS verification to
`rustls-platform-verifier`, whose Android backend needs a JNI initialisation
Termux has no JVM for, and it aborts the process on the first request:
`Expect rustls-platform-verifier to be initialized` (`android.rs:90`). The panic
precedes the empty-trust-store fallback added in
[pnpm/pnpm#13593](https://github.com/pnpm/pnpm/pull/13593), so that fallback never
runs. Pointing `NODE_EXTRA_CA_CERTS` at a CA bundle switches pnpm to its own root
store and avoids the verifier entirely; `SSL_CERT_FILE`, `cafile` and
`strict-ssl=false` do not, and a path that does not resolve falls back to the
panic. Reported as
[pnpm/pnpm#14777](https://github.com/pnpm/pnpm/issues/14777), and fixed by
[pnpm/pnpm#14783](https://github.com/pnpm/pnpm/pull/14783), which switches Android
to the bundled roots. That fix is merged but unreleased as of 12.4.0, so the
pinned version still needs the variable.

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

## When to retire the workarounds

Two of the three are already fixed upstream and waiting on a release, so the next
pnpm bump is the moment to re-test all three rather than carry them forward
blindly. `NODE_EXTRA_CA_CERTS` goes with the first release carrying
[pnpm/pnpm#14783](https://github.com/pnpm/pnpm/pull/14783), which stops asking the
Android platform verifier for a trust store it cannot reach. The `npm i -g` route
goes with the first release vendoring `get-pnpm@0.0.4` or later; the test is
whether `pnpm` and `pnpx` work from Corepack again.
`packageImportMethod: copy` waits on
[pnpm/pnpm#14782](https://github.com/pnpm/pnpm/issues/14782) and is harmless to
keep either way, on a filesystem that has no hard links to offer. None of the
three is worth a line of code here: they live in the contributor's shell and
machine config, and the repo only documents them.
