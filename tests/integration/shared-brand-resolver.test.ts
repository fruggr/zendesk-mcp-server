import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/server';
import {
  MOCK_BRAND,
  MOCK_BRAND_SECOND,
  MOCK_CATEGORY,
  MOCK_LOCALES,
  MOCK_SECTION,
} from '../msw-handlers';
import { mswServer } from '../setup';
import { makeConfig } from './harness';

// The brand subdomain resolver (GET /brands → subdomain) must be shared by
// EVERY consumer in a server: the tools AND the topology/article resources.
// Before, each consumer built its own resolver, so one session resolving the
// same brand from a tool and from the topology resource walked GET /brands
// twice (dlecan counted 4 in one session). One server = one resolver = one
// cached /brands walk.
describe('[stdio] shared brand resolver', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('walks GET /brands at most once across a tool call and a topology read', async () => {
    let brandsCalls = 0;
    const brandBase = `https://${MOCK_BRAND_SECOND.subdomain}.zendesk.com/api/v2/help_center`;
    mswServer.use(
      http.get('https://testsubdomain.zendesk.com/api/v2/brands', () => {
        brandsCalls += 1;
        return HttpResponse.json({ brands: [MOCK_BRAND, MOCK_BRAND_SECOND] });
      }),
      // The locked brand's Help Center endpoints the topology resource reads.
      http.get(`${brandBase}/locales`, () => HttpResponse.json(MOCK_LOCALES)),
      http.get(`${brandBase}/categories`, () => HttpResponse.json({ categories: [MOCK_CATEGORY] })),
      http.get(`${brandBase}/sections`, () => HttpResponse.json({ sections: [MOCK_SECTION] })),
    );

    // Single-brand lock: the topology resource pins to the first (only) brand,
    // and a brand-scoped tool resolves the same brand — both through the ONE
    // shared resolver.
    const config = makeConfig({ mode: 'all', brandIds: [String(MOCK_BRAND_SECOND.id)] });
    const server = createMcpServer(config, () => 'test-token');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'shared-resolver-test', version: '0.0.0' });
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };

    // A brand-scoped tool call (resolves the locked brand)…
    await client.callTool({ name: 'list_categories', arguments: {} });
    const afterTool = brandsCalls;

    // …and a topology resource read (resolves the same brand again).
    await client.readResource({ uri: 'zendesk-hc://topology' });

    expect(afterTool).toBeGreaterThan(0);
    // The resource read reused the tool's cached /brands walk — still one call.
    expect(brandsCalls).toBe(afterTool);
  });
});
