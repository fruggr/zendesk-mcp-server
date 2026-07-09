# Release automation

This document describes how dependency updates and releases are automated in this repository.

## Flow overview

```text
Renovate detects an update
        │
        ▼
Opens a PR against main (conventionalcommits-style title)
        │
        ▼
CI / build-and-test (vitest + tsc + biome)
        │
        ▼ green
Auto-merge (if the PR is eligible) or manual review
        │
        ▼
Squash & merge → commit on main using the PR title
        │
        ▼
.github/workflows/release.yml (push:main)
        │
        ▼
semantic-release scans commits since the last release
        │
        ├─ commit `fix(security): …`   → patch release published on npm + GitHub
        ├─ commit `fix: …`              → patch release
        ├─ commit `feat: …`             → minor release
        ├─ commit `BREAKING CHANGE`     → major release
        └─ commit `chore(deps): …`      → ignored (no release)
        │
        ▼ (when a release was cut)
Mirror the release into the official MCP registry
```

The commit-type → release-level mapping lives in `.releaserc.json` (preset `conventionalcommits`).

## MCP registry publishing

After semantic-release runs, the same `release.yml` job mirrors the release into
the [official MCP registry](https://registry.modelcontextprotocol.io) under the
name `io.github.fruggr/zendesk-mcp-server`, so registry-driven MCP clients pick up
each new version automatically.

- **Gating.** `@semantic-release/npm` rewrites `package.json`'s `version` in the
  working tree only when it actually publishes. The job snapshots the version
  before and after semantic-release; the publish steps run **only** when it
  changed, so `chore:` / `docs:` pushes (no release) never touch the registry.
- **Manifest.** `server.json` is **version-controlled** at the repo root
  (committed and reviewable). [`scripts/build-server-json.mjs`](../scripts/build-server-json.mjs)
  *seeds* it from everything that already lives in `package.json` (name from
  `mcpName`, npm identifier, version, repository, homepage) plus the
  registry/launch specifics (schema, transport, subdomain argument, env);
  regenerate the committed file with `pnpm build:server-json` whenever that
  metadata changes. A unit test asserts the committed file equals what the
  generator would seed, so it cannot drift from `package.json`.
- **Version sync.** At release, semantic-release does **not** regenerate the
  manifest; a `@semantic-release/exec` `prepareCmd` runs
  [`scripts/sync-server-json-version.mjs`](../scripts/sync-server-json-version.mjs)
  to update **only** the `version` fields to `${nextRelease.version}`, and
  `@semantic-release/git` commits `server.json` alongside `CHANGELOG.md` and
  `package.json`. The release commit therefore carries a clean one-line version
  diff, and `package.json` / `server.json` versions can never diverge. The
  MCP-registry publish step reads this committed, freshly-bumped file directly —
  there is no generate-from-scratch step in the release job.
- **Ownership.** The registry proves npm ownership via the `mcpName` field in
  `package.json` (which the generator uses as the `server.json` `name`).
- **Auth.** `mcp-publisher login github-oidc` reuses the workflow's
  `id-token: write` GitHub OIDC token — the same permission npm Trusted
  Publishing already relies on. No new secret, and the `io.github.fruggr/*`
  namespace is authorized because the workflow runs in the `fruggr` org's repo.
- **Resilience.** The publish is retried a few times to absorb npm propagation
  lag (the registry validates by fetching the freshly published npm tarball).

## Release notes content

semantic-release generates the notes from **every** commit between the previous
tag and the release commit — including the non-triggering ones (`chore`, `ci`,
`build`, `test`, `refactor`, `docs`, `style`). By default the `conventionalcommits`
preset hides those types, so they never surfaced in any changelog even though they
belong to a release range.

To keep them visible without drowning the consumer-facing notes (especially the
Renovate `chore(deps)` churn), the `release-notes-generator` step is replaced by a
thin local wrapper, [`scripts/release-notes-collapsed.js`](../scripts/release-notes-collapsed.js).
It calls the official generator, then post-processes the markdown:

- **Public sections** — Features, Bug Fixes, Performance Improvements, Reverts,
  `⚠ BREAKING CHANGES` — stay at the top.
- **Internal sections** — the non-triggering types above — are grouped into a single
  collapsed `<details>` block placed underneath.

No Handlebars template is reimplemented, so the wrapper survives preset version
bumps. The collapsed section titles and the `<summary>` label are configurable via
the `collapsedSections` / `collapsedSummary` plugin options in `.releaserc.json`.
The wrapper requires `@semantic-release/release-notes-generator` as an explicit
devDependency (kept on the same major as the one `semantic-release` bundles).

## Auto-merge policy

| Update kind                                       | Vulnerability (security) | Non-vulnerability        |
| ------------------------------------------------- | ------------------------ | ------------------------ |
| **patch** on `dependencies` (prod)                | auto-merge               | manual review            |
| **minor** on `dependencies` (prod)                | manual review            | manual review            |
| **patch** on `devDependencies`                    | auto-merge               | auto-merge               |
| **minor** on `devDependencies`                    | manual review\*          | auto-merge               |
| **major** (any deps, prod and dev)                | dashboard approval       | dashboard approval       |
| **patch / minor** on `pnpm` (`packageManager`)    | auto-merge               | auto-merge               |
| **patch / minor** on `pnpm.overrides` entries     | auto-merge               | auto-merge               |
| Weekly `lockFileMaintenance` (Friday before 8am, Europe/Paris) | auto-merge | auto-merge |
| GitHub Actions (`uses: org/action@…`)             | manual review            | manual review            |

\* Vulnerability-minor updates carry the `fix(security):` prefix, so merging them publishes a release. We keep them under manual review to allow an impact assessment first.

**Dashboard approval** means: no PR is opened automatically. The update appears in the Renovate-managed "Dependency Dashboard" issue with a checkbox. Ticking the checkbox triggers PR creation. This is intentional for majors, which usually require reading the upstream CHANGELOG and following a migration procedure.

Concrete examples:

- Patch vulnerability in `hono` (prod) → PR `fix(security): update hono to X` → auto-merge → patch release published.
- Minor vulnerability in `hono` (prod) → PR `fix(security): update hono to X` → **manual review** → patch release published on merge.
- Major vulnerability in `hono` (prod) → **no auto PR**, entry in the dashboard awaiting approval.
- Minor update of `vitest` (devDep) → PR `chore(deps): update vitest to X` → auto-merge → no release.
- Major update of `vitest` (devDep) → entry in the dashboard, manual approval required.
- Patch or minor bump of `pnpm` (via `packageManager` field) → PR `chore(deps): update pnpm to X` → auto-merge → no release. The corepack hash in `packageManager` is updated automatically by Renovate when the format is `pnpm@VERSION+sha512.HASH`.
- Non-vuln patch update of `hono` (prod) → PR `chore(deps): update hono to X` → manual review → no release on merge.
- GitHub Action digest bump → PR `chore(deps): update actions/X` → manual review → no release.
- Weekly Friday lockfile maintenance (before 8am, Europe/Paris) → PR `chore(deps): lock file maintenance` → auto-merge → no release. Picks up transitive updates whose parent ranges already allow the new version (e.g. a `^3.0.1`-ranged transitive moving from 3.1.0 to 3.1.2).

## Transitive vulnerabilities

`vulnerabilityAlerts` only acts on dependencies that appear in `package.json`. For vulnerabilities deep in the tree (visible in `pnpm-lock.yaml` only), two mechanisms cover the gap:

1. **`lockFileMaintenance`** (weekly, Friday morning) regenerates `pnpm-lock.yaml`. Any transitive whose parent range already accepts the patched version moves up — no manifest change needed. This covers the common case.
2. **`pnpm.overrides`** in `package.json` is required when the parent pins the vulnerable transitive at an exact version (or a range that excludes the patched one). The first time, a maintainer opens a `fix(security):` PR adding the override; from then on, Renovate auto-bumps the override entry via the dedicated `matchDepTypes: ["pnpm.overrides"]` rule (patch / minor only).

**Caveat — semver hygiene in the npm ecosystem.** Bumping a transitive via lockfile-only regen relies on the parent's declared semver range being accurate. Some maintainers ship breaking changes in patch/minor versions. The auto-merged `lockFileMaintenance` PR is therefore guarded by CI (typecheck + tests); a regression should fail the build and block the merge. Skim the diff when reviewing CI failures on these PRs.

## Admin prerequisites (out-of-PR settings)

These cannot be versioned; a repository (or org) admin must apply them **once**:

1. **Install the Renovate GitHub App** on the repository via https://github.com/apps/renovate. No secret to create.
2. **Settings → General → Pull Requests**:
   - Allow auto-merge ✓
   - Allow squash merging ✓
   - Default to PR title for squash merges ✓ (**critical**: without this, the `fix(security):` prefix is not carried into the squash commit on `main`, and no release is published)
3. **Settings → Branches → Branch protection rules** for `main`:
   - Require status checks to pass before merging ✓
   - Required check: `CI / build-and-test`
   - (Without this protection, `platformAutomerge` would merge the PR before CI finishes.)
4. **Settings → Code security → Dependabot security updates**: OFF. Renovate takes over via `vulnerabilityAlerts` (GHSA) + `osvVulnerabilityAlerts` (Google OSV), and we avoid duplicate PRs.

## Pause or disable

- **Pause Renovate on this repo**: add `"enabled": false` at the root of `renovate.json` and commit, or tick "rate limited" in the Dependency Dashboard.
- **Disable auto-merge globally**: replace `"platformAutomerge": true` with `false` in `renovate.json`. PRs keep being opened, but must be merged manually.
- **Disable auto-merge for one category**: remove `"automerge": true` from the relevant `packageRules` entry.

## Future broadening

Once test coverage is deemed sufficient to automate more widely:

- Auto-merge non-vuln prod `dependencies` patches by adding to `packageRules`:
  ```json
  {
    "matchDepTypes": ["dependencies"],
    "matchUpdateTypes": ["patch"],
    "automerge": true
  }
  ```
- Auto-merge GitHub Actions patches: replace the current `github-actions` rule with one matching `matchUpdateTypes: ["patch"]` and `automerge: true`.

Keep majors at `dependencyDashboardApproval: true`: they almost always require reading the upstream CHANGELOG.
