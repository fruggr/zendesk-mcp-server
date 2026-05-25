import { describe, expect, it } from 'vitest';
import type { ZendeskComment, ZendeskTicketAttachment } from '../../../src/types';
import {
  buildFingerprint,
  buildMarker,
  collectAttachments,
  collectMarkers,
  findLatestAnalysis,
  parseMarkers,
} from '../../../src/utils/attachment-marker';

const ATTACHMENT: ZendeskTicketAttachment = {
  id: 12345,
  file_name: 'screenshot.png',
  content_url: 'https://example.com/screenshot.png',
  content_type: 'image/png',
  size: 48213,
};

const makeComment = (overrides: Partial<ZendeskComment> = {}): ZendeskComment => ({
  id: 1,
  body: '',
  author_id: 1,
  public: false,
  created_at: '2026-05-01T10:00:00Z',
  ...overrides,
});

describe('buildFingerprint', () => {
  it('combines size and mime', () => {
    expect(buildFingerprint(ATTACHMENT)).toBe('size:48213,mime:image/png');
  });
});

describe('buildMarker / parseMarkers round-trip', () => {
  it('builds a parsable marker block', () => {
    const body = buildMarker(ATTACHMENT, 'A red error dialog with the text "Disk full".');
    const markers = parseMarkers(body, 42, '2026-05-01T10:00:00Z');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.attachment_id).toBe(12345);
    expect(markers[0]?.fingerprint).toBe('size:48213,mime:image/png');
    expect(markers[0]?.analysis).toContain('A red error dialog');
    expect(markers[0]?.comment_id).toBe(42);
  });

  it('parses multiple markers from one body', () => {
    const a = buildMarker(ATTACHMENT, 'Analysis A');
    const b = buildMarker({ ...ATTACHMENT, id: 99, file_name: 'b.png', size: 100 }, 'Analysis B');
    const combined = `Some prose.\n\n${a}\n\nMore prose.\n\n${b}`;
    const markers = parseMarkers(combined, 1, '2026-05-02T00:00:00Z');
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.attachment_id).sort((a, b) => a - b)).toEqual([99, 12345]);
  });

  it('ignores markers with a different version', () => {
    const body =
      '<!-- mcp:image-analysis v=2 attachment_id=1 fingerprint=x -->X<!-- /mcp:image-analysis -->';
    expect(parseMarkers(body, 1, '2026-05-01T10:00:00Z')).toHaveLength(0);
  });

  it('preserves analysis text containing marker delimiters via escape round-trip', () => {
    const tricky = '<!-- not a marker --> and <!-- /mcp:image-analysis --> embedded';
    const body = buildMarker(ATTACHMENT, tricky);
    // Stored bytes must NOT contain a second closing marker beyond our own.
    expect(body.match(/<!--\s*\/mcp:image-analysis\s*-->/g)).toHaveLength(1);
    const markers = parseMarkers(body, 1, '2026-05-01T10:00:00Z');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.analysis).toBe(tricky);
  });

  it('does not call parseMarkers with shared regex state across calls', () => {
    // Calling parseMarkers twice on bodies containing markers must each return
    // every marker (no /g lastIndex leakage between calls).
    const body = `${buildMarker(ATTACHMENT, 'first')}\n${buildMarker(ATTACHMENT, 'second')}`;
    expect(parseMarkers(body, 1, '2026-05-01T10:00:00Z')).toHaveLength(2);
    expect(parseMarkers(body, 1, '2026-05-01T10:00:00Z')).toHaveLength(2);
  });
});

describe('findLatestAnalysis', () => {
  it('returns undefined when no marker exists', () => {
    const comment = makeComment({ body: 'plain text' });
    expect(findLatestAnalysis([comment], ATTACHMENT)).toBeUndefined();
  });

  it('returns the marker when fingerprint matches', () => {
    const body = buildMarker(ATTACHMENT, 'desc');
    const comment = makeComment({ id: 7, body });
    const found = findLatestAnalysis([comment], ATTACHMENT);
    expect(found?.comment_id).toBe(7);
    expect(found?.analysis).toBe('desc');
  });

  it('ignores stale markers when fingerprint diverges', () => {
    const body = buildMarker(ATTACHMENT, 'old');
    const comment = makeComment({ body });
    const newer: ZendeskTicketAttachment = { ...ATTACHMENT, size: 99999 };
    expect(findLatestAnalysis([comment], newer)).toBeUndefined();
  });

  it('picks the most recent marker when several exist', () => {
    const oldComment = makeComment({
      id: 1,
      body: buildMarker(ATTACHMENT, 'first'),
      created_at: '2026-05-01T10:00:00Z',
    });
    const newComment = makeComment({
      id: 2,
      body: buildMarker(ATTACHMENT, 'second'),
      created_at: '2026-05-02T10:00:00Z',
    });
    const latest = findLatestAnalysis([oldComment, newComment], ATTACHMENT);
    expect(latest?.analysis).toBe('second');
    expect(latest?.comment_id).toBe(2);
  });
});

describe('collectMarkers / collectAttachments', () => {
  it('collects all markers across comments', () => {
    const c1 = makeComment({ id: 1, body: buildMarker(ATTACHMENT, 'a') });
    const c2 = makeComment({ id: 2, body: 'no marker' });
    expect(collectMarkers([c1, c2])).toHaveLength(1);
  });

  it('flattens attachments per comment', () => {
    const c1 = makeComment({ id: 1, attachments: [ATTACHMENT] });
    const c2 = makeComment({ id: 2 });
    const c3 = makeComment({ id: 3, attachments: [{ ...ATTACHMENT, id: 999 }] });
    const flat = collectAttachments([c1, c2, c3]);
    expect(flat).toHaveLength(2);
    expect(flat[0]?.comment.id).toBe(1);
    expect(flat[1]?.attachment.id).toBe(999);
  });
});
