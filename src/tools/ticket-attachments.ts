import * as z from 'zod/v4';
import { zendeskGet, zendeskPut } from '../client/zendesk-api.js';
import type { ZendeskComment, ZendeskTicket, ZendeskTicketAttachment } from '../types.js';
import { buildFingerprint, buildMarker, findLatestAnalysis } from '../utils/attachment-marker.js';
import type { ToolContext, ToolDefinition } from './definitions.js';

export interface TicketAttachmentsToolContext extends ToolContext {
  analysisFieldId?: number | undefined;
}

const fetchTicketAndComments = async (
  subdomain: string,
  token: string,
  ticket_id: number,
): Promise<{ comments: ZendeskComment[]; ticket: ZendeskTicket }> => {
  const [{ ticket }, { comments }] = await Promise.all([
    zendeskGet<{ ticket: ZendeskTicket }>(subdomain, token, `/tickets/${ticket_id}`),
    zendeskGet<{ comments: ZendeskComment[] }>(subdomain, token, `/tickets/${ticket_id}/comments`),
  ]);
  return { ticket, comments };
};

const findAttachment = (
  comments: ZendeskComment[],
  attachment_id: number,
): ZendeskTicketAttachment | undefined => {
  for (const comment of comments) {
    for (const attachment of comment.attachments ?? []) {
      if (attachment.id === attachment_id) return attachment;
    }
  }
  return undefined;
};

export const createTicketAttachmentTools = (
  ctx: TicketAttachmentsToolContext,
): ToolDefinition[] => {
  const { subdomain, getToken, analysisFieldId } = ctx;

  return [
    {
      name: 'record_attachment_analysis',
      namespace: 'tickets',
      readOnly: false,
      title: 'Record AI Image Analysis',
      description:
        'Persist an AI-inferred image description as a Zendesk internal note tagged with a versioned mcp:image-analysis marker. Call this after viewing an image returned by get_ticket_attachments so future ticket reads render the analysis inline next to the attachment. Idempotent on (attachment_id, fingerprint): a second call for the same image is a no-op unless replace_existing=true.',
      inputSchema: z.object({
        ticket_id: z.number().int().describe('Ticket ID'),
        attachment_id: z.number().int().describe('Attachment ID'),
        analysis: z.string().min(1).describe('Plain-text description written by the calling LLM'),
        replace_existing: z
          .boolean()
          .default(false)
          .describe('If true, write a new note even when an analysis already exists'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: async (params) => {
        const { ticket_id, attachment_id, analysis, replace_existing } = params as {
          ticket_id: number;
          attachment_id: number;
          analysis: string;
          replace_existing: boolean;
        };
        const token = await getToken();
        const { ticket, comments } = await fetchTicketAndComments(subdomain, token, ticket_id);

        const attachment = findAttachment(comments, attachment_id);
        if (!attachment) {
          return {
            content: [
              {
                type: 'text',
                text: `Attachment ${attachment_id} not found on ticket #${ticket_id}.`,
              },
            ],
          };
        }

        const existing = findLatestAnalysis(comments, attachment);
        if (existing && !replace_existing) {
          return {
            content: [
              {
                type: 'text',
                text: `Analysis for attachment ${attachment_id} already recorded on comment ${existing.comment_id} (${existing.recorded_at}). Pass replace_existing=true to override.`,
              },
            ],
          };
        }

        const body = buildMarker(attachment, analysis);
        await zendeskPut(subdomain, token, `/tickets/${ticket_id}`, {
          ticket: { comment: { body, public: false } },
        });

        let mirrorStatus: 'mirrored' | 'mirror_failed' | 'not_configured' = 'not_configured';
        if (analysisFieldId !== undefined) {
          const fingerprint = buildFingerprint(attachment);
          const existingField = ticket.custom_fields.find((f) => f.id === analysisFieldId);
          let merged: Record<string, unknown> = {};
          if (existingField && typeof existingField.value === 'string') {
            try {
              const parsed = JSON.parse(existingField.value) as unknown;
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                merged = parsed as Record<string, unknown>;
              }
            } catch {
              // Malformed prior content is overwritten below.
            }
          }
          merged[String(attachment_id)] = {
            analysis: analysis.trim(),
            fingerprint,
            recorded_at: new Date().toISOString(),
          };
          // The custom-field mirror is an advisory cache; the internal note
          // remains canonical. A mirror PUT failure must not abort the call,
          // otherwise the LLM would retry and end up with duplicate notes.
          try {
            await zendeskPut(subdomain, token, `/tickets/${ticket_id}`, {
              ticket: {
                custom_fields: [{ id: analysisFieldId, value: JSON.stringify(merged) }],
              },
            });
            mirrorStatus = 'mirrored';
          } catch {
            mirrorStatus = 'mirror_failed';
          }
        }

        const suffix =
          mirrorStatus === 'mirrored'
            ? ' and mirrored to the configured custom field'
            : mirrorStatus === 'mirror_failed'
              ? ' (advisory custom-field mirror failed; the internal note remains canonical)'
              : '';
        return {
          content: [
            {
              type: 'text',
              text: `Analysis recorded for attachment ${attachment_id} on ticket #${ticket_id} as a private note${suffix}.`,
            },
          ],
        };
      },
    },
  ];
};
