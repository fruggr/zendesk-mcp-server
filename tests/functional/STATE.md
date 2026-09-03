---
branch: claude/issue-48-analysis-czaqzt
current_run: 2026-09-03-pr264
holder: leading
---

# Functional test run state

`holder` is the narrative lock — only the holder pushes commits. Pass `holder`
to the other LLM before pushing. The leading LLM (web) reads reports and writes
verdicts; the executing LLM (local Claude Code CLI) runs scenarios and writes
raw + report artifacts.

| Scenario               | Status  | Last update |
| ---------------------- | ------- | ----------- |
| 01-namespace-readonly  | OK      | 2026-06-06  |
| 02-namespace-mixed     | OK      | 2026-06-06  |
| 03-single-readonly     | OK      | 2026-06-06  |
| 04-all-baseline        | OK      | 2026-06-06  |
| 05-strict-params       | OK      | 2026-06-27  |
| 06-requests-namespace  | PENDING | 2026-09-03  |
