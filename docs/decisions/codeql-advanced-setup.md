# CodeQL: advanced setup, so pull requests from forks can be merged

> **Build documentation, not user documentation.** Nothing here changes how the
> MCP server behaves for a client.

| | |
| --- | --- |
| **Status** | Decided; fork upload to be confirmed on the first external PR |
| **Date** | 2026-10-09 |
| **Issue** | [#362](https://github.com/fruggr/zendesk-mcp-server/issues/362) |
| **Question** | How do pull requests from forks satisfy the required `CodeQL` check? |
| **Answer** | Run code scanning from our own workflow (`.github/workflows/codeql.yml`) instead of GitHub's default setup, on `pull_request`. |

## Why

The `main` ruleset requires `CodeQL`, the check the code-scanning app posts once
an analysis is uploaded. Default setup does not analyse pull requests from forks
that target a protected branch, so on those the check never appeared and the PR
stayed blocked: #258 had to be reopened from an internal branch, and #333 was
stuck the same way.

The workflow reproduces default setup (languages `actions` and
`javascript-typescript`, `build-mode: none`, default query suite, push to `main`,
pull requests to `main`, weekly). Each analysis keeps default setup's category,
`/language:<lang>`, so alerts carry over without duplicates.

## Constraints

- **`pull_request`, never `pull_request_target`.** The latter runs with a write
  token and secrets, which fork code must never get.
- **Fork token.** On a fork's `pull_request` run, `GITHUB_TOKEN` is read-only,
  `security-events` included. GitHub documents that uploading CodeQL results
  still works there; this was not verified here before the switch. If it fails,
  the fallback is to drop `CodeQL` from the required checks, which is a
  maintainer's call, not a workflow change.
- **One setup at a time.** GitHub rejects advanced-setup uploads while default
  setup is on. An admin switches it off (*Settings → Advanced Security → CodeQL
  analysis → Switch to advanced*). Until this workflow is on `main`, other PRs
  get no `CodeQL` check, so merge it soon after the switch.
- **First-time contributors.** Their workflows still need a maintainer's
  approval before they run, `CodeQL` included.

## Alternatives rejected

- **Reopen every external PR from an internal branch** (what #282 did): manual
  each time, and splits the history and conversation across two PRs.
- **Remove `CodeQL` from the required checks:** fork code could then merge
  without any analysis.
- **Admin bypass per PR:** same weakness, plus a manual step.
