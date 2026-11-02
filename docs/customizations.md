# Customizations: teach every assistant how your team works

Zendesk admins can write, inside the server, what every user's AI assistant
receives on `/mcp`: house rules, ready-made workflows, reference material. They
write it once, from a back-office reserved to them, and every MCP client gets it,
whatever the client. No content ships with the server: each team writes its own.

This is an **HTTP** feature. A stdio server serves one person on their own
machine, where a skill or a rules file next to the client does the same job.

## Three kinds of content

| Kind | What the assistant gets | When it costs context | Use it for |
|---|---|---|---|
| **Instructions** | Text appended to the `instructions` every new session receives: global, then per namespace (`tickets`, `help_center`, `users`, `requests`, `preferences`) for the sessions that expose it | Every session | Short, always-on rules: tone, vocabulary, what never to do |
| **Prompts** | Entries in the client's prompt menu (`prompts/list`) | Only when a user starts one | Workflows started on purpose: draft a reply in our style, triage a ticket |
| **Skills** | A `SKILL.md`, plus optional files, served through the MCP Skills extension (SEP-2640) | Name and description always; the rest when the assistant loads it | Reference material or procedures the assistant picks up by itself: style guide, lexicon, translation workflow |

Limits: 4,000 characters per instructions scope and 12,000 for all of them; 32,000
per prompt; 32 files and 256,000 characters per skill.

### Skills on clients that do not support them

Many MCP clients do not support MCP skills yet. The server also serves every
skill as a prompt of the same name, and that conversion is lossy:

- the prompt carries `SKILL.md` only, truncated past 16,000 characters;
- the skill's other files are listed by URI, not included;
- scripts cannot run.

The server puts a header at the top of that prompt: it tells an assistant that
has the skill to load the skill instead, and tells the others what the
conversion dropped. Keep what matters in `SKILL.md`, and avoid skills that depend
on running code.

## The back-office: `/mcp/admin`

The same server answers a second endpoint. Add it as a **second connector** in
your MCP client, next to the usual one:

```
https://mcp.example.com/mcp/admin
```

- **Zendesk admins only.** Signing in with a Zendesk role other than `admin` is
  refused. The role is checked again at every token refresh (at least hourly)
  and on every call, so a demoted admin loses access.
- **Its own sign-in.** It is a separate OAuth resource: its token never opens
  `/mcp`, and a `/mcp` token never opens it.
- **Nothing else there.** It serves the `manage_customizations` tool and the
  `setup` prompt and skill, none of the Zendesk tools.
- **Writing needs write.** A server started with `--read-only`, or a sign-in
  granted only the `read` scope, gets no `manage_customizations`: what it would
  change reaches every user.

Start with the **`setup`** prompt (or skill). It reads what already exists,
helps choose between instructions, prompts and skills, and checks that nothing
repeats what the server already sends on its own: the Help Center it is connected
to, its locales, its category and section tree, its segments and permission
groups, and the SLA alert thresholds.

## When changes show

- **Instructions** reach new sessions: the protocol sends them once, when a
  session starts.
- **Prompts** reach open sessions on clients that refresh their prompt list.
- **Skills** reach the next session.

## Storage and backup

The content lives in the store named by
[`CUSTOMIZATION_STORE`](configuration.md#customization_store): by default a
folder in the config directory, `/data/customizations` in the container. It
holds one Markdown file per entry, readable and versionable as is:

```
customizations/
  instructions/global.md
  instructions/help_center.md
  prompts/draft-reply.md
  skills/lexicon/SKILL.md
  skills/lexicon/references/words.md
  .authors.json          # who changed each file, and when
```

Back up that folder with the rest of `/data`. Each instance has its own store:
two deployments (say, one for agents and one for customers) are configured
separately.

Why the content lives in the server rather than in Zendesk, and what is left
for later (a Git-backed store):
[the decision record](decisions/customizations.md).

---

← Back to the [README](../README.md).
