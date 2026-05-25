# Image attachment analysis

Tickets routinely have screenshots attached: an error dialog, a stack trace photo, a UI glitch capture. Out of the box the MCP server already exposes `get_ticket_attachments` (PR #13) which delivers those images to the calling LLM as MCP `image` content blocks. This page documents the **persistence layer** added on top: a single tool, `record_attachment_analysis`, that writes the LLM's description back to the ticket so subsequent reads include it inline.

## Why the LLM client does the vision

Other MCP servers in the wild ship `analyze_ticket_images` / `get_document_summary` tools that accept an `ANTHROPIC_API_KEY` (or equivalent) and call Claude from the server itself. We reject that pattern:

- **Architecturally redundant.** The MCP client already has a frontier-model LLM. A second one server-side means the user pays for two completions per analysis and receives a second-hand description from a server-chosen model.
- **Operationally heavy.** Every operator has to provision a vision provider key, manage budgets, handle rate limits, and rotate credentials.
- **Privacy-narrowing.** Routing images through a server-controlled provider means the user can't pick their own model or vendor.

Instead we use the MCP protocol's native `image` content type. `get_ticket_attachments` returns `{ type: 'image', data: <base64>, mimeType }`, which any MCP-compatible LLM ingests directly via its own multimodal capabilities. The server stays small, key-less, and provider-neutral.

## The two-tool flow

| Tool | PR | Mode | Purpose |
|------|----|------|---------|
| `get_ticket_attachments` | #13 (already on `main`) | read | Walks the ticket's comments, returns each `image/*` attachment as an MCP `image` content block (capped at 5 MB per image, 10 images per call); non-image attachments come back as text references. Accepts an optional `attachment_ids` parameter to skip the comments fetch when you already know which IDs to pull. |
| `record_attachment_analysis` | this PR | write | Persist the LLM's description as a Zendesk internal note containing a structured `mcp:image-analysis` marker. Idempotent on `(attachment_id, fingerprint)` unless `replace_existing=true`. |

Expected sequence:

```text
get_ticket(include_comments=true)
  → "Attachments: #12345 (image/png)" appears under the matching comment
get_ticket_attachments(ticket_id, attachment_ids=[12345])
  → LLM views the image natively (no extra comments fetch)
record_attachment_analysis(ticket_id, attachment_id=12345, analysis="…")
  → analysis stored as a private note with the marker
get_ticket(include_comments=true)
  → analysis rendered inline as a blockquote under the Attachments line
```

## The marker schema

Persistence is a **plain Zendesk internal note** with a structured HTML-comment block in its body:

```text
<!-- mcp:image-analysis v=1 attachment_id=12345 fingerprint=size:48213,mime:image/png -->
**AI-inferred image analysis** — `screenshot.png` (attachment 12345)

A login form with the email field highlighted in red, error message "Invalid credentials".

<!-- /mcp:image-analysis -->
```

Why this shape:

- **Human-readable** — agents browsing the Zendesk UI see the analysis as ordinary note content, with a clear "AI-inferred" label.
- **Regex-parseable** — the open/close HTML comments give deterministic boundaries: `/<!--\s*mcp:image-analysis\s+v=(\d+)\s+attachment_id=(\d+)\s+fingerprint=([^>]+?)\s*-->([\s\S]*?)<!--\s*\/mcp:image-analysis\s*-->/g`.
- **Versioned** — `v=1` lets future iterations evolve the schema without breaking historical tickets.
- **Fingerprinted on `(size, content_type)`** — if someone re-uploads `screenshot.png` with new bytes, the fingerprint changes, the old marker is treated as stale, and the next `get_ticket_attachments` call surfaces a fresh image with no prior analysis.
- **Delimiter-safe** — `buildMarker` escapes any `<!--` / `-->` sequence inside the LLM-written analysis to `&lt;!--` / `--&gt;` before embedding it, so a description containing HTML-comment tokens cannot prematurely close or spoof the surrounding marker block. `parseMarkers` reverses the escape when reading the analysis back.

The note is the **canonical source of truth**. `formatComment` reads markers off every comment at each ticket fetch and re-injects them as inline blockquotes under the matching attachment.

## Optional custom-field mirror

For high-volume triage agents that re-read the same tickets many times, scanning every comment body to rebuild the `attachment_id → analysis` map at each call is wasteful. Set `ZENDESK_MCP_ANALYSIS_FIELD_ID` to a Zendesk custom ticket field ID and `record_attachment_analysis` will mirror the data as JSON:

```json
{
  "12345": {
    "analysis": "A login form with...",
    "fingerprint": "size:48213,mime:image/png",
    "recorded_at": "2026-05-18T14:22:11.487Z"
  },
  "67890": {
    "analysis": "...",
    "fingerprint": "size:81920,mime:image/jpeg",
    "recorded_at": "2026-05-18T14:25:03.219Z"
  }
}
```

**The note remains canonical.** The custom field is purely an O(1) lookup index. If the two ever diverge (e.g. someone edits the note manually in the Zendesk UI), the parsed marker wins.

### Provisioning the custom field

1. Zendesk Admin Center → **Objects and rules** → **Tickets** → **Fields** → **Add field**.
2. Type: **Multi-line text**. Title: e.g. *MCP image analyses*. Visibility: **Agents only** (this is internal data).
3. Save. Note the numeric **Field ID** in the URL or in the field's properties.
4. Set `ZENDESK_MCP_ANALYSIS_FIELD_ID=<that-id>` in the server environment.

If the variable is not set, the server skips the mirror — only the internal note is written.

## Limits inherited from `get_ticket_attachments`

| Constraint | Default | Where it lives |
|---|---|---|
| Per-image cap (base64-embedded) | 5 MB | `MAX_ATTACHMENT_BYTES` in `src/constants.ts` |
| Max embedded images per call | 10 | `MAX_EMBEDDED_IMAGE_COUNT` |
| MIME types treated as image | `image/*` | `get_ticket_attachments` handler |
| Marker version | `v=1` | `src/utils/attachment-marker.ts` |

Images above the cap are returned as text references with the `content_url`, which the LLM can still record an analysis for if it inspects them out-of-band.

## Future work

- **Deterministic image pre-processing** (downscale via `sharp`, or use the `thumbnails[]` Zendesk already generates) so oversize images can still be analyzed inline. The pre-processing must remain deterministic — we will not invoke an LLM to summarize images server-side.
- **Document analysis** (PDFs, scans). Same architectural rule: extract text deterministically (pdfium, tesseract), never delegate semantic summarization to a server-side LLM.
- **`purge_attachment_analysis`** — not in v1: agents can delete the internal note manually from the Zendesk UI, and `record_attachment_analysis(replace_existing=true)` covers the re-run case.
