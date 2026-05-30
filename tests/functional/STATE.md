---
branch: claude/laughing-lovelace-HmZOn
current_run: 2026-05-30-pr53
holder: executor
---

# Functional test run state

`holder` is the narrative lock — only the holder pushes commits. Pass `holder`
to the other LLM before pushing. The leading LLM (web) reads reports and writes
verdicts; the executing LLM (local Claude Code CLI) runs scenarios and writes
raw + report artifacts.

| Scenario               | Status  | Last update |
| ---------------------- | ------- | ----------- |
| 01-namespace-readonly  | pending | -           |
| 02-namespace-mixed     | pending | -           |
| 03-single-readonly     | pending | -           |
| 04-all-baseline        | pending | -           |
