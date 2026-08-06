# Help Center context: instructions & MCP resources

Beyond tools, the [Zendesk MCP Server](../README.md) hands an LLM the structural
context it needs to work against *your* Help Center, so it stops guessing locales
or fuzzy-matching section names and uses real IDs instead. This document covers
what is exposed, what it costs, and how to turn each piece off.

Everything here is active only when the `help_center` namespace is, and every
fetch uses **the caller's own OAuth token**, so the context respects that user's
read permissions exactly like the tools do.

Clients that don't consume `instructions` or `resources` simply ignore them: the
whole feature degrades silently, it never breaks a session.

## `instructions` (sent on `initialize`)

A short, static blob auto-loaded by compliant clients. It names the Zendesk
subdomain and points at the topology resource. No Zendesk request is made to
build it.

## `zendesk-hc://topology` (pull-only resource)

A [pull-only MCP resource](https://modelcontextprotocol.io/docs/concepts/resources):
read on demand, never pushed. It returns Markdown describing

- the active locales, and which one is the default;
- the category → section tree, with IDs;
- the visibility user segments;
- the Guide permission groups;
- the calling user's role.

Prefer these IDs (`section_id`, `permission_group_id`, `user_segment_id`,
`locale`) over guessing from names.

Partial results are explicit. Listing permission groups and user segments
requires **Guide-admin / Help Center manager** rights. With a content-editor
token those two sections are marked *unavailable* rather than empty, and the
rest still renders; reuse those IDs from an existing article (`get_article`)
instead.

Large Help Centers stay concise. Past a size threshold the section tree is
summarized per category, with a pointer to the `list_sections` tool for the
detail.

## `zendesk-hc://article/{id}` (pull-only resources)

Two distinct capabilities behind one URI template.

Read-by-id: any article id can be read on demand and comes back as Markdown.
That is one Zendesk fetch, with no preloading, and it consumes no LLM context
until an article is actually opened.

Promoted pre-listing: the resource's *listing* surfaces the promoted
(*featured*) articles, so a user can pin one in clients that support resource
pinning or `@`-mentions. The companion `list_promoted_articles` tool returns the
same set.

### What the pre-listing costs

Only the pre-listing costs requests. Zendesk has no server-side filter for
promoted articles, so finding them means scanning article pages, one API request
per page, capped by
[`ZENDESK_ARTICLE_RESOURCES_SCAN_MAX_PAGES`](configuration.md#zendesk_article_resources_scan_max_pages).

- The scan runs only on a client's `resources/list` call or a tool call, **never
  at connect time**.
- The resource listing is cached briefly per session, so repeated
  `resources/list` calls coalesce.
- The `list_promoted_articles` tool performs a fresh scan on every call.

## Turning it off

| Flag | Effect |
|------|--------|
| [`--no-topology`](configuration.md#cli-reference) | Disables the `instructions` blob **and** the topology resource. They toggle together. |
| [`--no-promoted-articles`](configuration.md#cli-reference) | Disables the promoted pre-listing: both the resource `list` scan and the `list_promoted_articles` tool, so the server makes zero preloading requests. **Reading a known article by id stays available**, since it never preloads. |

## Branding the URI scheme

`zendesk-hc://` is the default. A deployer can rebrand it with
[`--hc-resource-scheme` / `HC_RESOURCE_SCHEME`](configuration.md#hc_resource_scheme):
`wiki`, for instance, yields `wiki://topology` and `wiki://article/{id}`. It
takes a bare RFC 3986 scheme, without `://`.

## Troubleshooting

`Permission denied` on `list_permission_groups`, `list_user_segments` or the
topology resource is covered in
[troubleshooting.md](troubleshooting.md#permission-denied-on-list_permission_groups-list_user_segments-or-the-topology-resource).

---

← Back to the [README](../README.md).
