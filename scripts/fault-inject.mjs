// Fault-injecting Zendesk, loaded into the real server process with
// `node --import ./scripts/fault-inject.mjs dist/index.js <subdomain> --mode all`.
//
// MSW patches the same global `fetch` the Zendesk client uses, so the running MCP
// server talks to a Zendesk that fails on demand — with no product code involved.
// Dev-only by construction: `msw` is a devDependency and nothing in `src/` imports
// it, so this cannot run from a published install.
//
// The mode comes from FAULT; every intercepted request prints `[fault] hit #N` on
// stderr, and that count is the evidence a retry policy is judged on — a write
// that must not be replayed shows exactly one hit, whatever its error message says.
//
// Known limit: `HttpResponse.error()` raises a failure with no syscall code, so
// this cannot tell a pre-send `ENOTFOUND` from an in-flight `ECONNRESET`. The
// "never reached Zendesk, retrying is safe" branch needs a real endpoint (a
// fault-injecting proxy) and is covered by unit tests only.

import { delay, HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

const SUB = process.env['SUB'] ?? 'validation';
const FAULT = process.env['FAULT'] ?? 'none';
const BASE = `https://${SUB}.zendesk.com/api/v2`;

let hits = 0;

const USER = { id: 9999, name: 'Validation User', email: 'validation@example.com', role: 'admin' };

const respond = async () => {
  hits += 1;
  process.stderr.write(`[fault] hit #${hits} (${FAULT})\n`);

  switch (FAULT) {
    case 'stall':
      // Never answers: the client's own per-attempt deadline has to fire.
      await delay('infinite');
      return HttpResponse.json({}, { status: 500 });
    case '500':
      return HttpResponse.json({ error: 'injected' }, { status: 500 });
    case '429':
      return HttpResponse.json({}, { status: 429, headers: { 'Retry-After': '600' } });
    case 'network':
      return HttpResponse.error();
    case 'flaky-then-ok':
      return hits === 1
        ? HttpResponse.json({ error: 'injected' }, { status: 500 })
        : HttpResponse.json({ user: USER, ticket: { id: 1, subject: 'ok', status: 'open' } });
    default:
      return HttpResponse.json({ user: USER, ticket: { id: 1, subject: 'ok', status: 'open' } });
  }
};

// Add a route here to reach another tool; the mode logic is shared.
const server = setupServer(
  http.get(`${BASE}/users/me`, respond),
  http.get(`${BASE}/tickets/:id`, respond),
  http.put(`${BASE}/tickets/:id`, respond),
);

server.listen({ onUnhandledRequest: 'bypass' });
process.stderr.write(`[fault] armed on ${BASE}, mode=${FAULT}\n`);
