import * as z from 'zod/v4';
import { zendeskUpload } from '../client/zendesk-api';
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
  file_base64: z.string().min(1).base64().describe('File content encoded as base64.'),
  content_type: z
    .string()
    .min(1)
    .default('application/octet-stream')
    .describe('MIME type, e.g. "text/plain", "image/png", "application/pdf".'),
});

export type AttachmentInput = z.infer<typeof attachmentSchema>;

/**
 * Upload each file via the Zendesk Uploads API, aggregating them under a single
 * upload token (the token from the first upload is passed to the next), and
 * return that token for use in a comment's `uploads` array.
 *
 * Sequential on purpose: the aggregation is what makes one token carry several
 * files, and it requires the previous token as input, so the calls cannot be
 * parallelized.
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

/** ` with N attachment(s)` for a confirmation message, or '' when there are none. */
export const formatAttachmentSuffix = (count?: number): string =>
  count ? ` with ${count} attachment(s)` : '';
