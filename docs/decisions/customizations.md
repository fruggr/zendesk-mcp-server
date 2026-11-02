# Admin customizations live in the server, behind `/mcp/admin`

**Status**: accepted (issues #44, #125, #390)

## Context

An assistant working against a Zendesk instance needs more than tool
signatures: the team's tone, vocabulary, procedures and workflows. Issue #44
planned to keep that guidance in Help Center articles, read with each user's
token; #125 met the same wall for prompts; #390 asked for a place where Zendesk
admins tune the connector at runtime.

Zendesk permissions cannot express what this content needs: **editable by
admins only, readable by every user of the connector, hidden from the help
desk.** An article read with the caller's own token is visible to whoever may
read it, and a section reserved to agents still shows in the agent's Help
Center. Storing configuration in articles is a workaround, not a store.

## Decision

- **The server owns the content.** Instructions, prompts and skills live in a
  store of this server (`CUSTOMIZATION_STORE`, a folder of Markdown files by
  default), loaded at startup and served from memory, so a server is still
  built synchronously. Nothing ships by default: the server carries the
  mechanism, each deployment its own workflows.
- **Admins write it from `/mcp/admin`.** A second endpoint on the same
  instance, its own OAuth resource (audience, RFC 9728 metadata, 401
  challenge), serving only the back-office: `manage_customizations` and the
  `setup` prompt and skill. A user adds it as a second connector.
- **Zendesk's `admin` role is the gate**, checked three times: at sign-in (the
  role `/users/me` returns), at every access-token mint for that resource,
  refresh included, so a demotion bites within one token lifetime, and on every
  tool call.
- **HTTP only.** A stdio server serves one person on their own machine, where a
  skill or rules file next to the client does the job. A stdio variant would
  add a branch (no role gate, a second store) for a rare use.
- **Every skill is also a prompt.** No client declares Skills support in its
  capabilities, so the server cannot tell who needs the fallback. It serves the
  `SKILL.md` body as a prompt of the same name, with a header added on read:
  load the skill instead when you have it; otherwise know what the conversion
  dropped (other files, scripts, the text past 16,000 characters). Nothing about
  prompts or skills goes into `instructions`: clients list them already, and a
  client with Skills support would pay for it in every session.

## Alternatives rejected

- **Help Center articles** (the #44 plan): the permission model above.
- **Admin tools on `/mcp`, shown by role.** No new connector, but every admin
  carries the back-office in every working session, and a tool list built from
  the role needs the role before the list. The endpoint keeps the daily context
  clean and is the pattern GitHub (`/readonly`) and Linear (`/mcp/readonly`)
  use.
- **A header selecting admin mode.** Not every client can set one (ChatGPT
  cannot; on Claude.ai Team a connector's headers are shared by the whole
  organization), and a header is a filter, never a proof of rights.
- **Recabling skills to prompts only for clients without Skills.** Nothing in
  the protocol tells the server which clients those are.

## Consequences

- **A file-tree store, on purpose.** The backend interface reads a tree and
  applies change sets with an author, so a Git backend (pull on load, a commit
  per change set) slots in without touching the model. It is not built yet.
- **One instance, one store.** Like the grant store, several replicas sharing
  one are not supported; two deployments for two audiences are configured
  separately.
- **Instructions reach new sessions only**: the protocol sends them once.
  Prompts are swapped in place on live sessions (`prompts/list_changed`); a skill
  added mid-session reaches the next one, because attaching the Skills extension
  declares the resources capability, and a server with no customization keeps
  its surface unchanged.
- **Not graded by Glama**, which inspects the stdio surface. The tool is held to
  the same floor by `tests/unit/tools/tool-quality.test.ts`.
- **Left for later**: the Git backend, a web page for the same back-office, and
  other admin settings from #390 (they would join the same endpoint).
