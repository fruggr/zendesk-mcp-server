# MCP tools reference: Zendesk MCP Server

The complete tool-by-tool reference for the [Zendesk MCP Server](../README.md),
grouped by namespace. Each tool is exposed according to the active `--mode`
(`all` exposes every tool individually; `namespace` and `single` wrap them in
proxies). See [Tool surface](../README.md#tool-surface) in the README for how
modes and the `--namespace` / `--tool` filters shape the surface.

The **Mode** column marks each tool as `read` or `write`; `--read-only` filters
out every `write` tool before the proxies are built.

<details>
<summary><strong>Tickets</strong></summary>

| Tool | Description | Mode |
|------|-------------|------|
| `get_ticket` | Retrieve a ticket by ID with optional comments and its live SLA state (resolved via a scoped search) | read |
| `get_ticket_history` | Read a ticket's change history (audit trail) as a chronological, oldest-first timeline of who changed what and when: field changes as before → after with actor names, comment presence (not bodies), system noise filtered; cursor-paginated | read |
| `get_ticket_attachments` | Download ticket attachments. Images are delivered as native multimodal content for the client's own model to analyze; oversize/over-limit images and non-images come back as text references | read |
| `search_tickets` | Search tickets using Zendesk query syntax, with per-result SLA state | read |
| `list_tickets` | List tickets with cursor-based pagination | read |
| `get_linked_incidents` | Get incidents linked to a problem ticket | read |
| `list_sla_policies` | List SLA policies with filter conditions and per-priority targets (requires an admin token, or a custom role with the SLA-management permission) | read |
| `list_ticket_fields` | List ticket field definitions (system + custom) with ids, types, and dropdown/multiselect option values, to resolve `custom_fields` ids and accepted values for create_ticket / update_ticket | read |
| `list_views` | List the agent's active views (saved ticket queues) with best-effort (cached, may show "(count updating)") ticket counts, to see where the workload sits before opening a queue | read |
| `get_view_tickets` | Read the tickets inside a view (by title or id) in the view's own configured sort order, cursor-paginated (no live SLA block; use search_tickets for that) | read |
| `list_macros` | List the active macros available to the authenticated user, with each macro's id, title, scope, and ordered actions | read |
| `create_ticket` | Create a new ticket with subject, description, priority, tags... | write |
| `update_ticket` | Update ticket status, priority, assignee, tags, custom fields | write |
| `add_private_note` | Add an internal note (not visible to requester), optionally with file attachments | write |
| `add_public_comment` | Add a public comment (visible to requester), optionally with file attachments | write |
| `manage_tags` | Add or remove tags on a ticket | write |
| `preview_macro_diff` | Preview a macro's changes to a ticket as a before → after diff (only changed fields + reply), without saving; commit via update_ticket / add_public_comment / add_private_note | write |

</details>

<details>
<summary><strong>Help Center</strong></summary>

| Tool | Description | Mode |
|------|-------------|------|
| `search_articles` | Full-text search across Help Center articles | read |
| `get_article` | Retrieve article by ID with full HTML body | read |
| `get_article_outline` | Compact outline of an article (sections + available translations) | read |
| `get_article_section` | Retrieve a single section (html or markdown) | read |
| `list_categories` | List all Help Center categories | read |
| `list_sections` | List sections, optionally filtered by category | read |
| `list_articles` | List articles with sorting and translation info | read |
| `list_promoted_articles` | List the promoted ("featured") articles (scans + filters client-side, page-capped) | read |
| `list_article_translations` | List available translations for an article | read |
| `list_article_attachments` | List attachments on an article | read |
| `list_permission_groups` | List Guide permission groups (needed to create articles; requires Guide-admin / Help Center manager rights) | read |
| `list_content_tags` | List Guide content tags (end-user visible), cursor-paginated with name-prefix filter and sort | read |
| `list_labels` | List article labels (search ranking, not user-visible) | read |
| `list_user_segments` | List user segments (article visibility; requires Guide-admin / Help Center manager rights) | read |
| `compare_translations` | Compare two locales of an article: target freshness (from updated_at), Zendesk `outdated` flag, structural verdict, and per-section presence status (word counts informational) | read |
| `create_article` | Create a new article in a section | write |
| `update_article` | Update article metadata (draft, promoted, labels, tags, visibility, section, sort position) | write |
| `reorder_article` | Move an article within its section (top/bottom/before/after), breaking position ties deterministically | write |
| `archive_article` | Archive (soft-delete) an article; recoverable only via the Guide admin UI | write |
| `create_article_translation` | Create a translation for an article | write |
| `update_article_translation` | Update an article's translation (full body) | write |
| `update_article_section` | Replace a single section of an article | write |
| `create_content_tag` | Create a new Guide content tag | write |
| `create_article_attachment` | Upload a file to a Help Center article (returns the created attachment) | write |

</details>

<details>
<summary><strong>Users & Organizations</strong></summary>

| Tool | Description | Mode |
|------|-------------|------|
| `get_current_user` | Get the authenticated user (verify identity) | read |
| `search_users` | Search users by name, email, or query syntax | read |
| `get_user` | Retrieve a user by ID | read |
| `get_organization` | Retrieve an organization by ID | read |
| `list_organizations` | List all organizations with pagination | read |

</details>

<details>
<summary><strong>Search</strong></summary>

| Tool | Description | Mode |
|------|-------------|------|
| `search` | Unified search across tickets, users, and organizations | read |

</details>

---

← Back to the [README](../README.md).
