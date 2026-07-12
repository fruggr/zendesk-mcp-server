# Contributing

Thanks for considering a contribution to `@fruggr/zendesk-mcp-server`. See the
[README](README.md) for what the project does and how to run it.

## Review philosophy

This server is maintained primarily by a single developer who works with AI
assistance (Claude Code) to write code. **AI-assisted contributions are
welcome and explicitly accepted**, on one condition: every submitted change
has been read line by line and is owned by a human author who can defend it.

Every PR goes through at least two automated review passes:

1. **Author-side review**, run locally before push. The author runs Claude
   Code on the diff and addresses anything found.
2. **CodeRabbit** in CI, which posts a high-level summary and inline review
   comments on the PR.

Final responsibility for merging belongs to the human author. Tooling catches
the mechanical issues; understanding the change is non-negotiable.

External contributions follow the same standard.

## Development setup

### Toolchain

| Tool | Version | Source of truth |
| ---- | ------- | ---------------- |
| Node | 24 | [`.nvmrc`](.nvmrc) — read by `nvm`, `fnm`, `mise`, `asdf`, `volta` |
| pnpm | 11 | [`package.json#packageManager`](package.json) (pinned with a corepack integrity hash) |

The toolchain (Node 24 + pnpm 11) is used to build, lint, type-check and
test the project. The **published package** still runs on Node 20+ (see
`engines.node`); a dedicated CI job installs the packed tarball on Node 20
and runs the smoke test to keep that promise honest.

```bash
# Clone, install, build
git clone https://github.com/fruggr/zendesk-mcp-server.git
cd zendesk-mcp-server && pnpm install && pnpm build
node dist/index.js <your-subdomain>

# Dev mode, OAuth (browser opens on first tool call)
pnpm dev -- <your-subdomain> --mode all

# Dev mode, HTTP transport (OAuth bearer from the MCP client)
pnpm dev -- <your-subdomain> --transport http --port 3000 --public-url http://localhost:3000

# Build / typecheck / lint / test
pnpm build && pnpm typecheck && pnpm check && pnpm test
```

To test a PR branch without publishing to npm — the `prepare` script builds on install:

```bash
npx -y github:fruggr/zendesk-mcp-server <your-subdomain>
npx -y github:fruggr/zendesk-mcp-server#my-feature-branch <your-subdomain>
```

Architecture, code style, submission bar and release workflow live in
[`AGENTS.md`](AGENTS.md).

## Before you start — avoid duplicate work

Two people building the same feature in parallel is wasted effort, and it has
happened here. Before writing any code for an issue:

1. **Check the issue is still live.** If it is closed as *completed* or labelled
   `released`, it already shipped — stop and, if a follow-up is needed, open a
   new issue for the delta.
2. **Search open *and* merged PRs for the issue number** (`is:pr #<n>`). A merged
   PR means it is done; an open PR means someone is mid-flight — comment there
   and coordinate instead of starting your own.
3. **Claim it.** Self-assign the issue and leave a short "I'm picking this up"
   comment so others see it is taken.
4. **Open your PR as a draft as early as possible** — the earliest signal to
   others that the work is in flight.

## Opening a pull request

1. Fork the repository.
2. Create a feature branch from `main`.
3. Write code in small, reviewable commits.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) — they
   directly drive the next version bump via semantic-release. See the
   [release table in the README](README.md#releases--versioning) for which
   prefixes trigger which bump.
5. Make the author checklist below pass locally.
6. Push your branch and open a PR against `main`.

If the PR resolves an issue, link it in the PR **description** with a GitHub
closing keyword so the issue closes automatically when the PR merges to `main`:

```
Closes #123
```

`close` / `closes` / `closed`, `fix` / `fixes` / `fixed` and
`resolve` / `resolves` / `resolved` all work. A bare `#123`, `Implements #123`
or `Part of #123` only *references* the issue — it does not close it. Keep the
keyword in the PR body (not just the title): the default squash merge discards
individual commit messages, but GitHub still reads closing keywords from the PR
description.

## Author checklist

The same checklist appears on the
[PR template](.github/pull_request_template.md):

- [ ] No open or merged PR already addresses the linked issue, and it is not
      already closed as completed / `released`.
- [ ] If the PR resolves an issue, its description links it with a closing
      keyword (`Closes #<n>`) so it auto-closes on merge to `main`.
- [ ] `pnpm test` passes locally.
- [ ] `pnpm test:coverage` meets the thresholds.
- [ ] `pnpm check` is clean (Biome lint + format).
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm build` produces a clean bundle.
- [ ] You have read the diff yourself, line by line.
- [ ] You ran a Claude Code review on the diff (see below).
- [ ] Documentation is updated if behavior or the tool surface changed
      (see [Documentation maintenance](AGENTS.md#documentation-maintenance)
      in `AGENTS.md`).
- [ ] If a new MCP tool was added, it is documented in
      `docs/mcp-tools-reference.md`.

## Code standards

- TypeScript with `@tsconfig/strictest` — no `any` escapes without a comment
  explaining why.
- Biome must be clean: `pnpm check` (and `pnpm check:fix` to auto-format).
- All `vitest` tests must pass: `pnpm test`.
- Coverage thresholds must hold: `pnpm test:coverage` (enforced in CI).
- Test-Driven Development is the default workflow:
  - **New features**: write a failing test first, then implement.
  - **Bug fixes**: write or adapt a test that reproduces the bug first, then
    fix the code.
  - **Existing tests are sacred**: a failing existing test is a potential
    regression. Investigate why before changing it. Never modify an existing
    test just to make it pass without understanding the root cause.
  - The Zendesk API is mocked with MSW handlers in `tests/msw-handlers.ts`.
    Never call the real API in tests.
- Functional style: pure functions, immutable data, no classes (except
  `ZendeskApiError`). See `AGENTS.md` for the full architecture and
  conventions.

## Author-side AI review

Before pushing, run a Claude Code pass on the diff. Suggested prompt — copy
this into your `claude` CLI from the branch:

> Read the diff between this branch and `main`. Look for: potential bugs,
> uncovered edge cases, inconsistencies with the project architecture,
> undocumented dependencies, security issues (secrets in cleartext,
> injections, missing zod validations), missing tests. Be strict.

Address everything Claude flags, or document in the PR description why
you're not addressing it.

## Submission quality bar

The bar to clear before opening a PR or asking the maintainer to review. It
applies the same way whether the code was written by a human or by an AI
assistant — the goal is that the patch survives external scrutiny and that the
human author can defend every line. The maintainer's review starts from the
assumption that everything below has already been done.

1. **Re-read your own diff in full.** No skimming. If a hunk no longer makes
   sense out of the context where you wrote it, rewrite it.
2. **Justify each change.** For every non-trivial hunk, you should be able to
   answer: why is this change here, what would break without it, and is it the
   smallest version of the fix.
3. **Look for what you didn't write.** Missing zod validation on an input,
   missing test for an edge case, missing README/AGENTS update on a renamed
   tool, missing error path. Reviewers find these — find them first.
4. **Self-review prompt.** Run the [Author-side AI review](#author-side-ai-review)
   pass on the diff against `main`. Address findings or document why you're
   skipping them in the PR description.
5. **Run the full local gate**: `pnpm check`, `pnpm typecheck`, `pnpm test`,
   `pnpm build`. A green CI on a non-green local run means a flaky check, not a
   free pass.
6. **Scope discipline.** Don't bundle unrelated cleanups into a feature PR. If
   you spot something worth fixing along the way, note it and open a separate PR.
7. **No invented behavior.** If a Zendesk API field, an SDK option, or a library
   API isn't confirmed by the docs, an existing test, or a typed response, mark
   it `// TODO:` and surface the question in the PR description rather than
   guessing.
8. **Mark the PR ready for review.** Flip a draft PR to "ready for review" once
   dev is done and the local gate is green — never leave it as a draft.

## What happens after you open the PR

1. CI runs lint, typecheck, tests with coverage thresholds, build, and a smoke
   test (single `build-and-test` job in `.github/workflows/ci.yml`).
2. CodeRabbit posts a high-level summary and review comments on the diff.
3. The maintainer reviews everything.
4. You address review findings.
5. Merge.

## Merge policy

- **Squash merge** is the default. The squashed commit message must follow
  Conventional Commits — that's what semantic-release reads to compute the
  next version.
- No force-push to `main`.
- The maintainer can self-merge, given that two automated review passes
  (author-side Claude + CodeRabbit) and the CI gate have run cleanly. This
  policy will tighten (require a human reviewer on PRs to `main`) once the
  project has its first regular contributor or first production user.

## Releases

Versions are calculated and published automatically from Conventional Commit
messages. See the [release section in the
README](README.md#releases--versioning) and the [Release
workflow](AGENTS.md#release-workflow) section in `AGENTS.md`.
