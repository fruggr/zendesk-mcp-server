import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mswServer } from '../../setup';

const openMock = vi.fn<(url: string) => Promise<unknown>>();

vi.mock('open', () => ({
  default: (url: string) => openMock(url),
}));

// Imported after vi.mock so the mocked `open` is bound.
const { authenticateViaBrowser } = await import('../../../src/auth/browser-oauth');

const SUB = 'testsubdomain';
const CLIENT_ID = 'test_client';

describe('authenticateViaBrowser', () => {
  beforeEach(() => {
    openMock.mockReset();
  });

  it('opens the browser once on the Zendesk authorize URL and completes the PKCE flow', async () => {
    mswServer.use(
      http.post(`https://${SUB}.zendesk.com/oauth/tokens`, async ({ request }) => {
        const body = await request.text();
        const params = new URLSearchParams(body);
        expect(params.get('grant_type')).toBe('authorization_code');
        expect(params.get('code')).toBe('the-auth-code');
        expect(params.get('client_id')).toBe(CLIENT_ID);
        expect(params.get('code_verifier')).toBeTruthy();
        return HttpResponse.json({
          access_token: 'token-abc',
          token_type: 'bearer',
          scope: 'read write',
        });
      }),
    );

    // Capture the authorize URL as soon as `open` is called, then
    // simulate the browser callback hitting our local HTTP server.
    openMock.mockImplementation(async (url: string) => {
      const authUrl = new URL(url);
      const redirectUri = authUrl.searchParams.get('redirect_uri');
      expect(redirectUri).toBeTruthy();
      // Fire the callback (decouple from this microtask so the auth
      // promise can keep awaiting the HTTP server).
      setImmediate(() => {
        fetch(`${redirectUri}?code=the-auth-code`).catch(() => {
          /* server will close as soon as it has processed the code */
        });
      });
      return {};
    });

    const result = await authenticateViaBrowser({
      subdomain: SUB,
      oauthClientId: CLIENT_ID,
      callbackPort: 0,
    });

    expect(result.access_token).toBe('token-abc');
    expect(openMock).toHaveBeenCalledTimes(1);

    const openedUrl = new URL(openMock.mock.calls[0]?.[0] ?? '');
    expect(openedUrl.origin).toBe(`https://${SUB}.zendesk.com`);
    expect(openedUrl.pathname).toBe('/oauth/authorizations/new');
    expect(openedUrl.searchParams.get('response_type')).toBe('code');
    expect(openedUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(openedUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(openedUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(openedUrl.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/localhost:\d+\/callback$/,
    );
  });
});
