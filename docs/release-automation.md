# Release automation

Ce document décrit comment les mises à jour de dépendances et les releases sont automatisées dans ce dépôt.

## Vue d'ensemble du flux

```
Renovate detecte un update
        │
        ▼
Ouvre une PR vers main (titre conventionalcommits)
        │
        ▼
CI / build-and-test (vitest + tsc + biome)
        │
        ▼ verte
Auto-merge (si la PR y est éligible) ou revue manuelle
        │
        ▼
Squash & merge → commit sur main avec le titre de la PR
        │
        ▼
.github/workflows/release.yml (push:main)
        │
        ▼
semantic-release lit les commits depuis la dernière release
        │
        ├─ commit `fix(security): …`   → release patch publiée sur npm + GitHub
        ├─ commit `fix: …`              → release patch
        ├─ commit `feat: …`             → release minor
        ├─ commit `BREAKING CHANGE`     → release major
        └─ commit `chore(deps): …`      → ignoré (pas de release)
```

Le mapping types de commit → niveau de release vit dans `.releaserc.json` (preset `conventionalcommits`).

## Politique d'auto-merge

| Type d'update                                     | Vuln (security)    | Non-vuln                |
| ------------------------------------------------- | ------------------ | ----------------------- |
| **patch** sur `dependencies` (prod)               | auto-merge         | revue manuelle          |
| **minor** sur `dependencies` (prod)               | revue manuelle     | revue manuelle          |
| **patch** sur `devDependencies`                   | auto-merge         | auto-merge              |
| **minor** sur `devDependencies`                   | revue manuelle\*   | auto-merge              |
| **major** (toutes deps, prod et dev)              | dashboard approval | dashboard approval      |
| GitHub Actions (`uses: org/action@…`)             | revue manuelle     | revue manuelle          |

\* Les vuln minor déclenchent un préfixe `fix(security):` donc une release sera publiée à la merge ; on la garde manuelle pour permettre l'analyse d'impact.

**Dashboard approval** signifie : aucune PR n'est ouverte automatiquement. L'update apparaît dans l'issue « Dependency Dashboard » créée par Renovate avec une case à cocher. Cocher la case déclenche la création de la PR. C'est conçu pour les majors qui demandent souvent une procédure de migration manuelle.

Exemples concrets :

- Vuln patch dans `hono` (prod) → PR `fix(security): update hono to X` → auto-merge → release patch publiée.
- Vuln minor dans `hono` (prod) → PR `fix(security): update hono to X` → **revue manuelle** → release patch publiée à la merge.
- Vuln major dans `hono` (prod) → **pas de PR auto**, ligne dans le dashboard à approuver.
- Update minor de `vitest` (devDep) → PR `chore(deps): update vitest to X` → auto-merge → pas de release.
- Update major de `vitest` (devDep) → ligne dans le dashboard, approbation manuelle requise.
- Update patch non-vuln de `hono` (prod) → PR `chore(deps): update hono to X` → revue manuelle → pas de release à la merge.
- Bump du digest d'une GitHub Action → PR `chore(deps): update actions/X` → revue manuelle → pas de release.

## Pré-requis admin (à valider hors PR)

Ces réglages ne peuvent pas être versionnés ; un admin du repo (ou de l'org) doit les appliquer **une fois** :

1. **Installer la GitHub App Renovate** sur le dépôt via https://github.com/apps/renovate. Aucun secret à créer.
2. **Settings → General → Pull Requests** :
   - Allow auto-merge ✓
   - Allow squash merging ✓
   - Default to PR title for squash merges ✓ (**critique** : sans ça, le titre `fix(security):` n'arrive pas dans le commit squashé sur `main` et la release n'est pas publiée)
3. **Settings → Branches → Branch protection rules** pour `main` :
   - Require status checks to pass before merging ✓
   - Required check : `CI / build-and-test`
   - (Sans cette protection, `platformAutomerge` mergerait la PR avant que la CI ait fini.)
4. **Settings → Code security → Dependabot security updates** : OFF. Renovate prend le relais via `vulnerabilityAlerts` (GHSA) + `osvVulnerabilityAlerts` (Google OSV) et on évite les PR en doublon.

## Pause ou désactivation

- **Mettre Renovate en pause sur ce repo** : ajouter `"enabled": false` à la racine de `renovate.json` et commiter, ou cocher « rate limited » dans la Dependency Dashboard.
- **Désactiver l'auto-merge globalement** : remplacer `"platformAutomerge": true` par `false` dans `renovate.json`. Les PR continueront d'être créées mais devront être mergées manuellement.
- **Désactiver l'auto-merge sur une catégorie précise** : retirer le `"automerge": true` du `packageRules` concerné.

## Procédure d'élargissement futur

Quand la couverture de tests sera jugée suffisante pour automatiser plus largement :

- Auto-merger les `dependencies` prod en patch non-vuln : ajouter dans `packageRules`
  ```json
  {
    "matchDepTypes": ["dependencies"],
    "matchUpdateTypes": ["patch"],
    "automerge": true
  }
  ```
- Auto-merger les GitHub Actions en patch : remplacer la règle `github-actions` actuelle par une variante avec `matchUpdateTypes: ["patch"]` et `automerge: true`.

Garder les majors en `dependencyDashboardApproval: true` : ils nécessitent presque toujours une lecture du CHANGELOG amont.
