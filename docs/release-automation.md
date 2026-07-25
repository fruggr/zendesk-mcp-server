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
`build`, `test`, `refactor`, `docs`, `style`). The `conventionalcommits` preset
hides those types in its default type list (`effect: 'hidden'`), so they never
surfaced in any changelog even though they belong to a release range. The
`presetConfig.types` array in `.releaserc.json` replaces that list wholesale, and
an entry without an `effect` defaults to visible — which is why the types are
listed there with a `section` and nothing else.

To keep them visible without drowning the consumer-facing notes (especially the
Renovate `chore(deps)` churn), the `release-notes-generator` step is replaced by a
thin local wrapper, [`scripts/release-notes-collapsed.js`](../scripts/release-notes-collapsed.js).
It calls the official generator, then post-processes the markdown:

- **Public sections** — Features, Bug Fixes, Performance Improvements, Reverts,
  `⚠ BREAKING CHANGES` — stay at the top.
- **Internal sections** — the non-triggering types above — are grouped into a single
  collapsed `<details>` block placed underneath.

No Handlebars template is reimplemented — the wrapper only reorganizes rendered
markdown, so it is insensitive to *how* the preset renders. It does not, however,
shield the pipeline from the preset ↔ writer coupling below. The collapsed section
titles and the `<summary>` label are configurable via the `collapsedSections` /
`collapsedSummary` plugin options in `.releaserc.json`. The wrapper requires
`@semantic-release/release-notes-generator` as an explicit devDependency (kept on
the same major as the one `semantic-release` bundles).

### Preset / writer version coupling

`conventional-changelog-conventionalcommits` v10 replaced Handlebars template
strings with render functions. Only `conventional-changelog-writer@9` understands
that shape, while `@semantic-release/release-notes-generator@14` (latest) still
declares `conventional-changelog-writer@^8`. Paired as published, writer 8 finds no
`mainTemplate` and renders **only the version header** — a release would still be
cut, with an empty CHANGELOG and GitHub Release. Upstream issue:
[semantic-release/release-notes-generator#992](https://github.com/semantic-release/release-notes-generator/issues/992).

`pnpm-workspace.yaml` therefore overrides the writer to `^9.2.0`. The override is
unscoped because `@semantic-release/commit-analyzer` declares the writer but never
imports it (it reads only the preset's `parserOpts`; release levels come from its
own default release rules), so forcing the writer cannot affect version detection —
only rendering. Verified on real repository history: the generated notes are
byte-identical to the pre-upgrade output.

**Removal condition:** drop the override once `release-notes-generator` publishes a
version depending on `conventional-changelog-writer@^9`. The canary assertions in
`tests/unit/release-notes-preset-render.test.ts` are what detects a broken pairing,
in either direction.

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
