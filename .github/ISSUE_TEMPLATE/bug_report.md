---
name: Bug report
about: Report a problem with the Zendesk MCP server
title: ""
labels: bug
assignees: ""
---

## Description

A clear and concise description of what the bug is.

## Steps to reproduce

1. Command run (e.g. `npx -y @fruggr/zendesk-mcp-server acme --mode single`)
2. MCP client used (Claude Desktop / Claude Code / VS Code / other)
3. Tool / operation called
4. ...

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include the error message or the tool response.

## Logs

Re-run with `LOG_LEVEL=debug` and paste the relevant stderr output.
**Do not paste tokens, API keys, or other secrets** — the server never logs
them, so redact anything you add by hand.

## Environment

- Package version: <!-- e.g. 1.4.0 -->
- Node.js version: <!-- node --version -->
- OS:
- Auth method: <!-- OAuth 2.1 PKCE / API token -->
- Mode / flags: <!-- e.g. --mode namespace --read-only -->

## Additional context

Anything else that helps diagnose the issue.
