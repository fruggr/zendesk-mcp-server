import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { afterEach, describe, expect, it } from 'vitest';
import { startHttpTransport } from '../../src/transports/http';
import { createZendeskOAuthMock, localServerPassthrough } from '../msw-handlers';
import { mswServer } from '../setup';
import { clientOptionsFor, type Era, makeConfig } from './harness';
import { authorize, DCR_REDIRECT, registerDcrClient, tokenRequest } from './oauth-client';

// The /mcp/admin back-office end to end: its own OAuth resource, admins only,
// and what an admin writes there reaching /mcp sessions.

type Started = Awaited<ReturnType<typeof startHttpTransport>>;

const started: Started[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const handle of started.splice(0)) await handle.close();
});

let zendesk: ReturnType<typeof createZendeskOAuthMock>;

const start = async (role = 'admin') => {
  zendesk = createZendeskOAuthMock({ role });
  mswServer.use(localServerPassthrough, ...zendesk.handlers);
  const handle = await startHttpTransport(
    makeConfig({
      transport: 'http',
      oauthStore: 'memory://',
      customizationStore: 'memory://',
      oauthMasterSecret: Buffer.alloc(32, 8).toString('base64'),
    }),
  );
  started.push(handle);
  return `http://127.0.0.1:${handle.port}`;
};

/** A sign-in for `resource`: the access token, or the authorization error. */
const signIn = async (baseUrl: string, resource: string) => {
  const registration = await registerDcrClient(baseUrl);
  const clientId = registration.body.client_id ?? '';
  const result = await authorize(baseUrl, { clientId, redirectUri: DCR_REDIRECT, resource });
  if (!result.code) return { error: result.error, description: result.errorDescription };
  const tokens = await tokenRequest(baseUrl, {
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: DCR_REDIRECT,
    code: result.code,
    code_verifier: result.verifier,
    resource,
  });
  return {
    accessToken: tokens.body.access_token,
    refresh: () =>
      tokenRequest(baseUrl, {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: tokens.body.refresh_token ?? '',
        resource,
      }),
  };
};

const connect = async (baseUrl: string, path: string, token: string, era: Era = '2025') => {
  const client = new Client({ name: 'admin-test', version: '0.0.0' }, clientOptionsFor(era));
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}${path}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
};

const callAdmin = async (client: Client, args: Record<string, unknown>) => {
  const result = await client.callTool({ name: 'manage_customizations', arguments: args });
  const [first] = result.content as Array<{ text: string }>;
  return { isError: result.isError === true, text: first?.text ?? '' };
};

const SKILL = `---
name: lexicon
description: "Our product vocabulary: use it when writing anything customer-facing."
---

Say "workspace", never "account".`;

describe('[http] /mcp/admin back-office', () => {
  it('is its own protected resource, with its own metadata', async () => {
    const baseUrl = await start();
    const metadata = (await (
      await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp/admin`)
    ).json()) as { resource: string };
    expect(metadata.resource).toBe(`${baseUrl}/mcp/admin`);

    const res = await fetch(`${baseUrl}/mcp/admin`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp/admin"`,
    );
  });

  it('accepts neither token on the other endpoint', async () => {
    const baseUrl = await start();
    const main = await signIn(baseUrl, `${baseUrl}/mcp`);
    const admin = await signIn(baseUrl, `${baseUrl}/mcp/admin`);
    const post = (path: string, token: string | undefined) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 't', version: '0' },
          },
        }),
      });
    expect((await post('/mcp/admin', main.accessToken)).status).toBe(401);
    expect((await post('/mcp', admin.accessToken)).status).toBe(401);
  });

  it('refuses the sign-in of a user whose Zendesk role is not admin', async () => {
    const baseUrl = await start('agent');
    expect(await signIn(baseUrl, `${baseUrl}/mcp/admin`)).toEqual({
      error: 'access_denied',
      description:
        'This connector is reserved for Zendesk administrators, and your Zendesk role is not admin.',
    });
    // The same user still signs in to /mcp.
    expect((await signIn(baseUrl, `${baseUrl}/mcp`)).accessToken).toBeDefined();
  });

  it('mints no new back-office token once the user is no longer an admin', async () => {
    const baseUrl = await start();
    const admin = await signIn(baseUrl, `${baseUrl}/mcp/admin`);
    const main = await signIn(baseUrl, `${baseUrl}/mcp`);
    zendesk.setRole('agent');
    const refused = await admin.refresh?.();
    expect(refused?.status).toBe(400);
    expect(refused?.body.error).toBe('access_denied');
    expect((await main.refresh?.())?.body.access_token).toBeDefined();
  });

  it.each(['2025', '2026'] as const)(
    'serves only the back-office surface (%s era)',
    async (era) => {
      const baseUrl = await start();
      const { accessToken = '' } = await signIn(baseUrl, `${baseUrl}/mcp/admin`);
      const admin = await connect(baseUrl, '/mcp/admin', accessToken, era);
      expect((await admin.listTools()).tools.map((tool) => tool.name)).toEqual([
        'manage_customizations',
      ]);
      expect((await admin.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual(['setup']);
      expect(admin.getInstructions()).toContain('back-office');
    },
  );

  it.each(['2025', '2026'] as const)(
    'delivers what an admin writes to new /mcp sessions (%s era)',
    async (era) => {
      const baseUrl = await start();
      const { accessToken: adminToken = '' } = await signIn(baseUrl, `${baseUrl}/mcp/admin`);
      const { accessToken: mainToken = '' } = await signIn(baseUrl, `${baseUrl}/mcp`);
      const admin = await connect(baseUrl, '/mcp/admin', adminToken, era);

      const saved = await callAdmin(admin, {
        action: 'set',
        kind: 'instructions',
        name: 'global',
        content: 'Answer customers in a warm, plain tone.',
      });
      expect(saved.isError).toBe(false);
      expect(saved.text).toContain('Answer customers in a warm, plain tone.');
      expect(
        (
          await callAdmin(admin, {
            action: 'set',
            kind: 'prompt',
            name: 'draft-reply',
            description: 'Draft a reply in our house style.',
            content: 'Draft a reply to the ticket I name, in our house style.',
          })
        ).isError,
      ).toBe(false);
      expect(
        (await callAdmin(admin, { action: 'set', kind: 'skill', name: 'lexicon', content: SKILL }))
          .isError,
      ).toBe(false);

      const main = await connect(baseUrl, '/mcp', mainToken, era);
      expect(main.getInstructions()).toContain(
        "Your team's own instructions, set by its Zendesk admins:\n\nAnswer customers in a warm, plain tone.",
      );
      expect((await main.listPrompts()).prompts.map((prompt) => prompt.name).sort()).toEqual([
        'draft-reply',
        'lexicon',
      ]);
      const derived = await main.getPrompt({ name: 'lexicon' });
      expect(derived.messages[0]?.content).toHaveProperty(
        'text',
        expect.stringContaining(
          'If "lexicon" is among the skills available to you, stop reading this prompt',
        ),
      );
      const skills = await new SkillsClient(main).list();
      expect(skills.skills.map((skill) => skill.uri)).toEqual(['skill://lexicon/SKILL.md']);
      // Nothing of the back-office leaks into /mcp.
      expect((await main.listTools()).tools.map((tool) => tool.name)).not.toContain(
        'manage_customizations',
      );
    },
  );

  it('explains a refused edit and changes nothing', async () => {
    const baseUrl = await start();
    const { accessToken = '' } = await signIn(baseUrl, `${baseUrl}/mcp/admin`);
    const admin = await connect(baseUrl, '/mcp/admin', accessToken);
    const refused = await callAdmin(admin, {
      action: 'set',
      kind: 'skill',
      name: 'lexicon',
      content: SKILL.replace(
        '"Our product vocabulary: use it',
        'Our product vocabulary: use it',
      ).replace('customer-facing."', 'customer-facing.'),
    });
    expect(refused).toEqual({
      isError: true,
      text: expect.stringContaining('quote a value holding ": "'),
    });
    expect((await callAdmin(admin, { action: 'list' })).text).toContain('## Skills\n(none)');
  });
});
