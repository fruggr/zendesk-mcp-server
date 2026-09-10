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
| **Question** | pnpm 12 rewrites the CLI in Rust and ships it as a native binary per host. 12.4.0 is the first release to publish an Android one. Worth pinning, when two of its Android paths are broken upstream? |
| **Answer** | **Yes.** Start-up drops from ~4 s to ~0.2 s on the affected device, and both gaps have a local answer that costs the other platforms nothing. |

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

## The two Android gaps

**Corepack cannot provision the binary.** The wrapper's Corepack entry
(`bin/pnpm.mjs`) downloads the executable through the `get-pnpm` copy it vendors,
and that copy refuses any platform outside `darwin`/`linux`/`win32` — so Corepack
reports `Sorry! pnpm does not provide a pre-built binary for android` even though
the package exists on npm ([pnpm/pnpm#14679](https://github.com/pnpm/pnpm/issues/14679)).
[pnpm/get.pnpm.io#59](https://github.com/pnpm/get.pnpm.io/pull/59) is the fix; it
is still a draft, and it reaches this device only through a `get-pnpm` release
that a later pnpm then vendors. `npm i -g --prefix ~/.local/share/pnpm pnpm@<pin>`
is the way in meanwhile: npm resolves the optional dependency for the host and the
package's own install script links the binary over the placeholder bin.

Installing into pnpm's own home (`~/.local/share/pnpm`, which pnpm asks you to
keep first on `PATH`) rather than over `$PREFIX/bin/pnpm` is deliberate: it leaves
Corepack's shim in place, so deleting `~/.local/share/pnpm/bin/pnpm*` is the whole
rollback. Note that the shadowing is machine-wide, so a checkout still pinned to
pnpm 11 then fails with `ERR_PNPM_PNPM_ENGINE_NO_NATIVE_BINARY`, because pnpm 12
honours the pin itself and no pnpm 11 binary can exist here. `pmOnFail: ignore`
would skip that switch, but it is only settable in a project's
`pnpm-workspace.yaml`, so there is no local escape hatch. The answer is to land
the pin everywhere.

**Every registry request panics.** The Rust CLI delegates TLS verification to
`rustls-platform-verifier`, whose Android backend needs a JNI initialisation
Termux has no JVM for, and it aborts the process on the first request:
`Expect rustls-platform-verifier to be initialized` (`android.rs:90`). The panic
precedes the empty-trust-store fallback added in
[pnpm/pnpm#13593](https://github.com/pnpm/pnpm/pull/13593), so that fallback never
runs. Pointing `NODE_EXTRA_CA_CERTS` at a CA bundle switches pnpm to its own root
store and avoids the verifier entirely; `SSL_CERT_FILE`, `cafile` and
`strict-ssl=false` do not, and a path that does not resolve falls back to the
panic. Tracked upstream in
[pnpm/pnpm#14777](https://github.com/pnpm/pnpm/issues/14777).

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

## When to retire the workarounds

The `npm i -g` route goes away when a pnpm release vendors a `get-pnpm` that
knows about Android; check whether `pnpm` and `pnpx` still work from Corepack
after any pnpm bump. `NODE_EXTRA_CA_CERTS` goes away when pnpm stops asking the
Android platform verifier for a trust store it cannot reach. Neither is worth
keeping a line of code for here: both live in the contributor's shell, and the
repo only documents them.
