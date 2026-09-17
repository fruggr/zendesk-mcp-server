import * as z from 'zod/v4';
import { zendeskUpload } from '../client/zendesk-api';
import { MAX_BASE64_INPUT_CHARS, MAX_BASE64_INPUT_MB } from '../constants';
import type { ZendeskUpload } from '../types';

/**
 * File-attachment input, shared by every tool that can carry files on a comment.
 *
 * Lives here rather than inside a tool factory because both audiences need it:
 * an agent attaching a screenshot to a public reply, and an end user attaching a
 * log to their own request. The Uploads API (`POST /api/v2/uploads.json`) is
 * documented as allowed for end users, so the same code path serves both.
 */
export const attachmentSchema = z.object({
  file_name: z.string().min(1).describe('File name, e.g. "app.log" or "screenshot.png".'),
  file_base64: z
    .string()
    .min(1)
    // `abort` is what makes the ordering pay: zod respects declaration order but
    // does not stop on its own, so the base64 regex would still scan megabytes
    // already disqualified by length (measured 1.67ms -> 0.33ms). In-range inputs
    // and the published schema are unaffected.
    .max(MAX_BASE64_INPUT_CHARS, {
      abort: true,
      error: (issue) =>
        `Attachment too large: ${(issue.input as string).length} base64 characters, limit ${MAX_BASE64_INPUT_CHARS}. Downscale the file, split the upload, or link to it instead of uploading.`,
    })
    .base64()
    .describe(
      `File content encoded as base64. At most ${MAX_BASE64_INPUT_CHARS} characters (about ${MAX_BASE64_INPUT_MB} MB of file), and the attachments of one call must stay under that total; the HTTP transport additionally caps request bodies at 4 MB.`,
    ),
  content_type: z
    .string()
    .min(1)
    .default('application/octet-stream')
    .describe('MIME type, e.g. "text/plain", "image/png", "application/pdf".'),
});

export type AttachmentInput = z.infer<typeof attachmentSchema>;

/**
 * The optional `attachments` array parameter, capped as a whole.
 *
 * The per-file cap in `attachmentSchema` bounds one attachment; this bounds a
 * call, because `attachments` is a list and every file rides in the same
 * message (#205).
 */
export const attachmentsParam = (description: string) =>
  z
    .array(attachmentSchema)
    .superRefine((files, refinement) => {
      const total = files.reduce((sum, file) => sum + file.file_base64.length, 0);
      if (total > MAX_BASE64_INPUT_CHARS)
        refinement.addIssue({
          code: 'custom',
          message: `Attachments too large: ${total} base64 characters in total, limit ${MAX_BASE64_INPUT_CHARS}. Send fewer files per call.`,
        });
    })
    .optional()
    .describe(description);

/**
 * Upload each file via the Zendesk Uploads API, aggregating them under a single
 * upload token (the token from the first upload is passed to the next), and
 * return that token for use in a comment's `uploads` array. Sequential of
 * necessity: each call needs the previous token.
 */
export const uploadAttachments = async (
  subdomain: string,
  token: string,
  files: AttachmentInput[],
): Promise<string> => {
  let uploadToken: string | undefined;
  for (const file of files) {
    const { upload } = await zendeskUpload<{ upload: ZendeskUpload }>(
      subdomain,
      token,
      file.file_name,
      Buffer.from(file.file_base64, 'base64'),
      file.content_type,
      uploadToken,
    );
    uploadToken = upload.token;
  }
  return uploadToken as string;
};

export const formatAttachmentSuffix = (count?: number): string =>
  count ? ` with ${count} attachment(s)` : '';
