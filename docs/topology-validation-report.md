# Topology feature — validation report

**Date:** 2026-06-13
**Server under test:** `zendesk-local` (MCP), connected to the "fruggr" Help Center
**Operator:** Damien Lecan (id `9387526715165`, role `admin`)
**Method:** read the `zendesk-hc://topology` resource, then independently cross-check
every section of it against the live tools (`list_categories`, `list_sections`,
`list_user_segments`, `list_permission_groups`, `get_current_user`,
`list_articles`).

## TL;DR

The topology resource is a **faithful mirror** of the live API: **0 data
discrepancies** across categories (13), sections (40), user segments (4),
permission groups (2), role/identity, and locales. The tree is rendered in full
with no truncation note.

**One bug to investigate:** the **first** read of `zendesk-hc://topology` failed
with a transient auth error while the five tool calls issued in the same batch
all succeeded with the same bearer. A plain retry (no change) succeeded. See
[Action items](#action-items).

---

## 1. Server init instructions

Verbatim instructions provided by `zendesk-local` at initialization:

> This MCP server is connected to the Zendesk Help Center of "fruggr".
>
> Before creating or editing Help Center content, read the resource zendesk-hc://topology.
> It describes the active locales (and the default one), the category → section tree with IDs,
> the visibility user segments, the permission groups, and your current role.
> Prefer the IDs from that resource (section_id, permission_group_id, user_segment_id, locale)
> over guessing from names.

- **Subdomain?** Not given. The instructions name the HC instance ("fruggr") but
  not the technical subdomain (e.g. `fruggr.zendesk.com`).
- **`zendesk-hc://topology`?** Yes, cited by URI, with the instruction to read it
  before any create/edit and to prefer its IDs over name-guessing.

## 2. Exposed resources + topology read

`ListMcpResourcesTool` returns exactly one resource:

```json
[{"name":"help-center-topology","title":"Zendesk Help Center topology",
  "uri":"zendesk-hc://topology",
  "description":"Active locales, category → section tree, visibility segments, permission groups, and your role. Read before creating or editing content.",
  "mimeType":"text/markdown","server":"zendesk-local"}]
```

### Transient auth failure on first read (bug)

The first `read` of `zendesk-hc://topology` returned:

```text
MCP error -32603: Authentication failed. Your Zendesk token may be expired or invalid. Re-authenticate to get a new token.
```

…while, **in the same batch of calls**, the five tools (`list_categories`,
`list_sections`, `list_user_segments`, `list_permission_groups`,
`get_current_user`) all succeeded with the same bearer. An identical retry — no
re-auth, no change — succeeded. This points to a transient failure specific to
the **resource-read code path**, not a real token expiry (otherwise the tools
would have failed too).

### Full topology content (second, successful read)

```markdown
# Zendesk Help Center topology — fruggr

**Your access**: Damien Lecan (id 9387526715165), role "admin".

## Locales
- Default: fr
- Active: en-us, fr

## Categories → sections
- **Gouvernance IA** (29193628989213) — Gouvernance de l'IA dans votre entité
  - **Fonctionnement général** (29193757324189)
- **Accessibilité** (19918231873565) — Une solution d'évaluation automatisée d'aide à la mise en conformité de l'accessibilité de vos applications web.
  - **Fonctionnement général** (19918665202845)
  - **Télécharger l'extension** (21652793638173)
  - **Freemium ** (32303268073501)
  - **Recommandations** (19918744138013)
  - **Scanner Accessibilité** (35103402757789) — Un agent autonome pour auditer vos applications internes
  - **Références** (25588118057373) — Les documentations de référence
- **Cockpit ESG IT** (30851087042845) — Vision globale ESG de l'IT de votre entité
  - **Fonctionnement général** (30851120012317)
- **Module Services** (19917943803549) — écoconception des services numériques
  - **Applications Mobile** (28094409863837) — Analyser des applications mobiles
  - **Fonctionnement général** (22803117260445) — Introduction au module Service
  - **Page par page ** (19918603889181) — Analyser en mode page par page
  - **Unité fonctionnelle ** (19918600842781) — Les analyses d'Unité Fonctionnelle
  - **Scores, empreintes et audits** (19918654178205) — Concepts et explications
  - **Recommandations ** (9898718725533) — Référentiel de règles
  - **Scanner Services** (19924168017821) — Analyser des services numériques internes
  - **FAQ** (25809226850973) — Questions fréquentes sur le module
  - **Référence** (26852105066653)
- **Module Infrastructure** (19918244287901) — impact environnemental de l'IT
  - **Fonctionnement général** (19918754774813)
  - **Recommandations** (19919054005789)
  - **Référence** (26852095196957)
- **Module Parc Informatique** (20144698842397) — émissions de GES du parc IT
  - **Fonctionnement général** (19923000736285) — Introduction au module Parc informatique
  - **FAQ** (25471740471197)
  - **Recommandations** (20144729261725) — Les recommandations du module
- **Module Digital Workplace ** (25435791647773) — impact environnemental de la Digital Workplace
  - **Fonctionnement général ** (25436535103389)
- **Administration** (19918289992733) — éléments essentiels ou transverses
  - **Fonctionnement général** (19919401261725)
  - **FAQ** (19919115096349)
  - **Références** (19919414664733)
- **Modules complémentaires** (19923012830493) — Des modules additionnels
  - **Bilan Maturité Numérique Responsable** (19923036682397)
- **Nouveautés et informations produit** (11538213067677) — Découvrez les fonctionnalités
  - **Conformité Accessibilité ** (36166963504285)
  - **Cockpit ESG IT** (36166928101405)
  - **Gouvernance IA** (36166874362269)
  - **Nouveautés produit** (28893592998813)
  - **Nouveautés du mois ** (11539185819037) — Suivi mensuel des nouveautés produits fruggr
  - **Notifications de service** (11544861624349) — maintenances planifiées et incidents
  - **Communication interne D4B** (13064764773917) — fonctionnalités à venir et mode de déploiement
  - **Annonces** (11538997050397) — Nouvelles fonctionnalités, corrections de bugs majeures
- **Club utilisateur** (16301205121949) — Des thématiques explorées chaque mois
  - **Replay ** (16301203527965)
- **Modes opératoires internes** (13059225486877) — procédures internes
  - **Modes opératoires internes** (9816536711069)
- **Documentation Partenaires** (14560863527965) — No description
  - **Guide formation** (14560917039773)
  - **Kit commercial** (14560897913117)

## Visibility (user segments)
- **Signed-in users** (8578337159197) — signed_in_users — Built-in
- **Agents and admins** (8578337159325) — staff — Built-in
- **Client club utilisateur** (16301291695517) — signed_in_users
- **D4B + partenaire** (9745438335517) — staff

## Permission groups
- **Administrateurs** (8578307079197) — Built-in
- **Modifications guide utilisateur membres de D4B** (8875923026973)
```

> Note: some descriptions are abbreviated above for readability; IDs, names and
> structure are reproduced exactly as returned.

## 3. Corroboration against the tools

| Dimension | Topology | Tool | Verdict |
|---|---|---|---|
| Categories | 13 | `list_categories` → 13 | ✅ IDs + names identical |
| Sections | 40 (across the 13 categories) | `list_sections` → 40 | ✅ IDs + `category_id` attachment identical |
| User segments | 4 | `list_user_segments` → 4 | ✅ identical |
| Permission groups | 2 | `list_permission_groups` → 2 | ✅ identical |
| Role / identity | Damien Lecan (`9387526715165`), admin | `get_current_user` → same | ✅ identical |

- **User segments:** `8578337159197`, `8578337159325`, `16301291695517`
  (Client club utilisateur), `9745438335517` (D4B + partenaire). 4/4.
- **Permission groups:** `8578307079197` (Administrateurs, built-in),
  `8875923026973` (Modifications guide utilisateur membres de D4B). 2/2.
- **Sections:** all 40 IDs and their `category_id` map one-to-one. Only the
  ordering differs (tool returns a flat list, resource a grouped tree) — no
  content discrepancy.

**Discrepancies: none in the data.** The only incident is the transient
auth failure on the resource-read path (see §2).

## 4. Locales

Resource declares: **Default = `fr`**, **Active = `en-us`, `fr`**.

Corroboration via `list_articles` (`include_translations: true`, 12-article sample):

- 100% of sampled articles have `Source locale: fr` and a single translation: `fr`.
- No `en-us` translation observed in the sample.

**Coherent**, with a nuance: `fr` is confirmed as the default and dominant
locale. `en-us` is declared *active* (enabled in the HC config), which is
consistent — "active locale" means allowed, not that translated content exists.
In practice the HC is authored almost exclusively in `fr`; `en-us` is open but
(in this sample) has no translated content.

## 5. Placement scenario (no content created)

**Chosen real topic:** a guide *"How to launch an audit with the Autonomous
Accessibility Scanner"*. This is a real topic — the article *"Introduction au
Scanner Autonome Accessibilité"* (`35255171090973`) already lives in the target
section, so the new guide is its natural follow-up.

| Parameter | Value | Source |
|---|---|---|
| `section_id` | `35103402757789` — *Scanner Accessibilité* (under category *Accessibilité* `19918231873565`) | **Topology** tree. Double-confirmed: present in `list_sections`, and a real article already lives there. |
| `locale` | `fr` | **Topology** (`Default: fr`). Confirmed: all sampled articles are source-locale `fr`. |
| `permission_group_id` | `8875923026973` — *Modifications guide utilisateur membres de D4B* | **Topology** permission groups. |
| visibility (optional) | `8578337159197` — *Signed-in users* | **Topology** user segments. |

**No ID was guessed** — all four IDs come from the topology (and each is
corroborated by a tool). The only judgment call is `permission_group_id`: a
choice between two **real** topology groups — `8578307079197` (Administrateurs,
built-in) vs `8875923026973` (D4B editorial group). The D4B editorial group is
recommended for normal guide authoring; the built-in admin group is more
restrictive/cross-cutting. This is an editorial choice between two legitimate
topology IDs, not a guessed ID.

## 6. Bounding / truncation

**Full tree, no truncation.** The resource lists all 13 categories and all 40
sections in full, with no note such as *"more than 100 categories/sections… use
list_sections/list_categories"*. Expected: the HC is well under the 100-element
threshold, so the in-extenso rendering is legitimate. The truncation guard could
not be positively exercised on this instance (it would require a HC with > 100
elements).

## Summary

| Criterion | Result |
|---|---|
| Instructions reference the resource | ✅ (subdomain no, instance name "fruggr" yes) |
| Resource exposed + readable | ⚠️ Readable, but **1st read failed with transient auth error** while tools succeeded |
| Topology content == tools | ✅ **0 discrepancies** (13 cat / 40 sec / 4 segments / 2 groups / role) |
| Locales coherent | ✅ (`fr` confirmed; `en-us` active but no content observed) |
| Article placement without guessing | ✅ all IDs come from the topology |
| Bounding / truncation | ✅ full tree, no truncation note (threshold not reached) |

## Action items

1. **Investigate the transient auth failure on the resource-read path.** The
   first `read` of `zendesk-hc://topology` returned `-32603 Authentication
   failed` while five tool calls in the same batch succeeded with the same
   bearer; a plain retry then succeeded. Suspect a token-refresh / bearer-capture
   race specific to the resource handler vs the tool handler. Reproduce, then
   add a regression test (the resource read must use the same valid bearer as the
   tools).
