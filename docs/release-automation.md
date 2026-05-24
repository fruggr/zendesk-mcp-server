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
```

The commit-type → release-level mapping lives in `.releaserc.json` (preset `conventionalcommits`).

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
