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
upstream.listen({ onUnhandledFrame: 'bypass' });

// The test process needs one browser hop from the mock: Zendesk's authorize
// page. The relay serves that route alone, to a constant URL; only the query
// string comes from the request.
const AUTHORIZE = 'https://testsubdomain.zendesk.com/oauth/authorizations/new';

const relay = createServer(async (req, res) => {
  const incoming = new URL(req.url ?? '/', 'http://relay');
  if (req.method !== 'GET' || incoming.pathname !== '/oauth/authorizations/new') {
    res.writeHead(404).end();
    return;
  }
  const target = new URL(AUTHORIZE);
  for (const [key, value] of incoming.searchParams) target.searchParams.append(key, value);
  const reply = await fetch(target, { redirect: 'manual' });
  res.writeHead(reply.status, Object.fromEntries(reply.headers));
  res.end(Buffer.from(await reply.arrayBuffer()));
});
// Never what keeps the server alive: its shutdown paths are under test too.
relay.unref();
relay.listen(0, '127.0.0.1', () => {
  console.error(`zendesk_relay_ready port=${(relay.address() as AddressInfo).port}`);
});
