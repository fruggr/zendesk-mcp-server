# Package-manager install benchmark

Compares how fast three tools install **this repository's** dependencies
(`--frozen-lockfile`, ~740 resolved packages):

| Contender | What actually runs |
| --- | --- |
| **pnpm** (JS) | `pnpm install --frozen-lockfile` with the pure TypeScript engine (`usePacquet=false`) — the baseline. |
| **pnpm Rust** (`pnpm-rust`) | The same command with **[pacquet](https://github.com/pnpm/pacquet)**, pnpm's official Rust rewrite, driving the fetch/link (materialization) phase. |
| **nub** | `nub install --frozen-lockfile` — the Rust [nub](https://nubjs.com) toolkit, reading the same `pnpm-lock.yaml`. |

> **Why pnpm Rust isn't a separate binary.** As of pnpm 11.2, the Rust rewrite
> (pacquet) is not a standalone package manager — it plugs into pnpm as an
> experimental install engine. Adding it to `configDependencies` delegates the
> materialization phase of `pnpm install --frozen-lockfile` to the Rust binary
> while pnpm still owns dependency resolution. That is the honest, apples-to-apples
> comparison and it's what `pnpm-rust` measures here. pacquet is a **preview** and
> may fall back to the JS installer (or fail) — the harness records that as N/A
> rather than aborting.

## Scenarios

`--frozen-lockfile` install is the common ground (it's the only phase pacquet
accelerates today, and it's nub's headline benchmark). Scripts are ignored
(`--ignore-scripts`): a package-manager benchmark measures resolve + fetch +
link, not the project's own build. The differentiator is cache state:

| Scenario | State before each timed run | Measures |
| --- | --- | --- |
| `cold` | empty store **and** no `node_modules` | full fetch + extract + link (network every run) |
| `warm` | store populated, `node_modules` removed | link/import only — no network |
| `repeat` | store **and** `node_modules` present | up-to-date "nothing to do" path |

Each tool runs in its **own isolated copy** of the repo with a private
store/cache (`$WORKDIR/<tool>/`), so the real checkout is never modified and no
two tools share a cache. The lockfile, `package.json` and `pnpm-workspace.yaml`
are copied verbatim; for `pnpm-rust` the pacquet `configDependencies` entry is
appended to the copy only.

## Running locally

```bash
# From the repo root. Installs nothing globally except the tools you choose.
benchmarks/package-managers/run.sh
```

Prerequisites:

- **pnpm** — already the repo's package manager.
- **[hyperfine](https://github.com/sharkdp/hyperfine)** (recommended) for
  statistical timing. Without it the script falls back to a simple timing loop.
  `brew install hyperfine` · `cargo install hyperfine` · `apt install hyperfine`.
- **nub** (optional): `curl -fsSL https://nubjs.com/install.sh | bash`. If absent,
  the `nub` rows are reported as _not installed_ and the rest still runs.
- **pnpm-rust**: needs no extra install — it's pnpm + a config dependency. It
  requires network access to fetch the pacquet binary on first use.

Results land in `benchmarks/package-managers/results/`:

- `results.md` — the tables (also printed to stdout),
- `results.json` — structured numbers for scripting,
- raw per-cell files (`hf-*.json` / `simple-*.txt`) and `manifest.jsonl`.

### Tuning knobs (environment variables)

| Var | Default | Meaning |
| --- | --- | --- |
| `TOOLS` | `pnpm pnpm-rust nub` | Which tools to run. |
| `SCENARIOS` | `cold warm repeat` | Which cache scenarios to run. |
| `COLD_RUNS` / `WARM_RUNS` / `REPEAT_RUNS` | `3` / `8` / `8` | Timed runs per scenario. |
| `PACQUET_RANGE` | `^0.1.0` | Version range added to `configDependencies`. |
| `NUB_INSTALL_ARGS` | `--frozen-lockfile --ignore-scripts` | Extra args for `nub install`. |
| `OUT_DIR` | `./results` | Where results are written. |
| `WORKDIR` | a fresh `mktemp -d` | Scratch dir for the isolated repo copies. |
| `KEEP_WORKDIR` | `0` | Set `1` to keep the scratch dir for inspection. |

Example — only the warm scenario, more runs, just pnpm vs nub:

```bash
SCENARIOS=warm WARM_RUNS=15 TOOLS="pnpm nub" benchmarks/package-managers/run.sh
```

## Running on GitHub

`.github/workflows/pm-benchmark.yml` runs this on a clean `ubuntu-latest`
runner. Trigger it from the **Actions** tab (`Run workflow`) — inputs let you
pick tools, scenarios and run counts. The tables are written to the job
**Summary**, and `results/` is uploaded as an artifact.

## Caveats

- **Cold numbers include network variance.** GitHub-hosted runners and your
  laptop pull from different mirrors at different speeds; compare cold results
  within a single run, not across machines. `warm` and `repeat` are the stable,
  reproducible signals.
- **pacquet is a preview.** It may not materialize every install and can fall
  back to the JS engine; when that happens the two pnpm columns converge (or
  `pnpm-rust` shows N/A). That's a real finding, not a harness bug.
- **nub reads but does not own the lockfile.** It consumes `pnpm-lock.yaml` in
  compatibility mode; behaviour and available flags may change — override with
  `NUB_INSTALL_ARGS` if a flag is renamed.
- Small dependency trees (this repo) understate absolute differences. The
  *ratios* are the interesting part; re-point `run.sh` at a larger project to
  amplify them.
