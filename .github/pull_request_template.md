## Summary
<!-- In 1-3 sentences, what does this PR change and why? -->

## Linked issue
<!-- If this PR resolves an issue, use a GitHub closing keyword so the issue
     auto-closes when this PR is squash-merged into `main`:
       Closes #123   (also accepted: Fixes #123 / Resolves #123)
     A bare "#123", "Implements #123" or "Part of #123" references the issue
     but does NOT close it. Keep the keyword in this description (GitHub reads
     the PR body on squash merge). If this PR isn't tied to an issue, write "None". -->
Closes #<n>

## Type of change
- [ ] Bug fix
- [ ] New feature
- [ ] Refactor (no external behavior change)
- [ ] Documentation
- [ ] Tooling / CI

## Author checklist
- [ ] I checked no open or merged PR already addresses the linked issue, and the issue is not already closed as completed / `released`
- [ ] If this PR resolves an issue, its description above links it with a closing keyword (`Closes #<n>`) so it auto-closes on merge to `main`
- [ ] `pnpm test` passes locally
- [ ] `pnpm test:coverage` meets the thresholds
- [ ] `pnpm check` is clean (lint + format)
- [ ] `pnpm typecheck` passes
- [ ] I have read the diff myself, line by line
- [ ] I ran a Claude Code review on the diff and addressed its findings
- [ ] Documentation is updated where needed
- [ ] If this PR adds an MCP tool: it is documented in `docs/mcp-tools-reference.md`
- [ ] If the change has runtime-observable behaviour: this PR carries a `## Functional validation plan` (authored with `/functional-validation-plan`), and it has been executed by an independent validator (`/run-validation-plan`) whose report is posted as a PR comment

## Notes for the reviewer (human or AI)
<!-- Points worth attention, design choices to validate, alternatives ruled out -->
