/**
 * API token authentication for stdio transport.
 * Uses Basic auth: base64(email/token:api_token)
 */
export const buildBasicAuthHeader = (email: string, apiToken: string): string => {
  const credentials = `${email}/token:${apiToken}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
};
