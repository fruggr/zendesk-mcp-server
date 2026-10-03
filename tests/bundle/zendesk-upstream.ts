/**
 * Preloaded into the bundled server (`node --import tsx --import <this> dist/index.js`):
 * the stateful Zendesk mock lives inside the server process, where its token
 * exchange happens. The test process reaches the same mock through a loopback
 * relay for the browser hops of the sign-in (Zendesk's authorize page), so both
 * sides see one set of codes and tokens.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupServer } from 'msw/node';
import { createZendeskOAuthMock, handlers } from '../msw-handlers';

const upstream = setupServer(...createZendeskOAuthMock().handlers, ...handlers);
upstream.listen({ onUnhandledRequest: 'bypass' });

// The relay only ever reaches the mocked tenant: it takes a path, never a URL.
const ZENDESK = 'https://testsubdomain.zendesk.com';

const relay = createServer(async (req, res) => {
  const target = new URL(req.url ?? '/', ZENDESK);
  if (target.origin !== ZENDESK) {
    res.writeHead(400).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const reply = await fetch(target, {
    method: req.method ?? 'GET',
    redirect: 'manual',
    ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
  });
  res.writeHead(reply.status, Object.fromEntries(reply.headers));
  res.end(Buffer.from(await reply.arrayBuffer()));
});
// Never what keeps the server alive: its shutdown paths are under test too.
relay.unref();
relay.listen(0, '127.0.0.1', () => {
  console.error(`zendesk_relay_ready port=${(relay.address() as AddressInfo).port}`);
});
