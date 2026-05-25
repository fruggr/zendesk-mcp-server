import type { ZendeskComment, ZendeskTicketAttachment } from '../types.js';

export const MARKER_VERSION = 1;

export interface AttachmentMarker {
  attachment_id: number;
  fingerprint: string;
  analysis: string;
  comment_id: number;
  recorded_at: string;
}

// Source pattern (rebuilt per call so parseMarkers stays pure and free of
// shared mutable regex state from a /g lastIndex).
const MARKER_PATTERN =
  '<!--\\s*mcp:image-analysis\\s+v=(\\d+)\\s+attachment_id=(\\d+)\\s+fingerprint=([^>]+?)\\s*-->([\\s\\S]*?)<!--\\s*\\/mcp:image-analysis\\s*-->';

export const buildFingerprint = (attachment: ZendeskTicketAttachment): string =>
  `size:${attachment.size},mime:${attachment.content_type}`;

// Neutralize HTML-comment boundaries inside analysis text so a description
// containing `<!--` / `-->` (or our exact `mcp:image-analysis` tokens) cannot
// prematurely close or spoof the surrounding marker block.
const escapeMarkerDelimiters = (text: string): string =>
  text.replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;');

const unescapeMarkerDelimiters = (text: string): string =>
  text.replaceAll('&lt;!--', '<!--').replaceAll('--&gt;', '-->');

export const buildMarker = (attachment: ZendeskTicketAttachment, analysis: string): string => {
  const fingerprint = buildFingerprint(attachment);
  const trimmed = escapeMarkerDelimiters(analysis.trim());
  return [
    `<!-- mcp:image-analysis v=${MARKER_VERSION} attachment_id=${attachment.id} fingerprint=${fingerprint} -->`,
    `**AI-inferred image analysis** — \`${attachment.file_name}\` (attachment ${attachment.id})`,
    '',
    trimmed,
    '',
    '<!-- /mcp:image-analysis -->',
  ].join('\n');
};

// Strip the human-readable header line that buildMarker prepends so the parsed
// `analysis` field contains only the LLM-written description.
const HEADER_LINE_REGEX = /^\s*\*\*AI-inferred image analysis[^\n]*\n+/;

export const parseMarkers = (
  body: string,
  comment_id: number,
  created_at: string,
): AttachmentMarker[] => {
  const found: AttachmentMarker[] = [];
  const matches = body.matchAll(new RegExp(MARKER_PATTERN, 'g'));
  for (const match of matches) {
    const version = Number(match[1]);
    if (version !== MARKER_VERSION) continue;
    const attachment_id = Number(match[2]);
    const fingerprint = (match[3] ?? '').trim();
    const raw = match[4] ?? '';
    const analysis = unescapeMarkerDelimiters(raw.replace(HEADER_LINE_REGEX, '').trim());
    if (Number.isFinite(attachment_id) && fingerprint) {
      found.push({ attachment_id, fingerprint, analysis, comment_id, recorded_at: created_at });
    }
  }
  return found;
};

export const collectMarkers = (comments: ZendeskComment[]): AttachmentMarker[] => {
  const all: AttachmentMarker[] = [];
  for (const comment of comments) {
    if (!comment.body) continue;
    all.push(...parseMarkers(comment.body, comment.id, comment.created_at));
  }
  return all;
};

export const findLatestAnalysis = (
  comments: ZendeskComment[],
  attachment: ZendeskTicketAttachment,
): AttachmentMarker | undefined => {
  const fingerprint = buildFingerprint(attachment);
  const matching = collectMarkers(comments).filter(
    (m) => m.attachment_id === attachment.id && m.fingerprint === fingerprint,
  );
  if (matching.length === 0) return undefined;
  // Latest by recorded_at (ISO strings sort lexicographically).
  return matching.reduce((latest, current) =>
    current.recorded_at > latest.recorded_at ? current : latest,
  );
};

export const collectAttachments = (
  comments: ZendeskComment[],
): Array<{ comment: ZendeskComment; attachment: ZendeskTicketAttachment }> => {
  const out: Array<{ comment: ZendeskComment; attachment: ZendeskTicketAttachment }> = [];
  for (const comment of comments) {
    for (const attachment of comment.attachments ?? []) {
      out.push({ comment, attachment });
    }
  }
  return out;
};
