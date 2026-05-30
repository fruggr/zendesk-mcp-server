import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { type Config, ConfigSchema } from '../../src/config';

/**
 * A client connected to a running MCP server through a real transport, plus a
 * `close` that tears down both ends. The integration suites talk to the server
 * exclusively through `client`, i.e. across the wire, never by calling handlers
 * directly.
 */
export interface ConnectedClient {
  client: Client;
  /**
   * Origin the client is connected to (e.g. `http://127.0.0.1:43997` for the
   * HTTP harness). Undefined for transports without an HTTP surface (stdio).
   * Tests that need to poke sibling endpoints (`/healthz`, `.well-known/...`)
   * use this rather than reaching into the SDK transport's internals.
   */
  baseUrl?: string;
  close(): Promise<void>;
}

/**
 * Transport-agnostic seam for the integration suite. Each transport (stdio
 * today, HTTP in a later PR) provides one implementation; the shared scenarios
 * in `core-scenarios.ts` run against any harness unchanged.
 */
export interface IntegrationHarness {
  /** Short transport name, used to label the test suite (e.g. 'stdio'). */
  readonly name: string;
  /** Boot a server with `config` and return a client connected to it. */
  connect(config: Config): Promise<ConnectedClient>;
}

/**
 * Build a fully-valid test Config. The defaults match the MSW handlers, whose
 * BASE is `https://testsubdomain.zendesk.com/...`, so requests made by the
 * server are intercepted. Override any field per scenario.
 */
export const makeConfig = (overrides: Partial<Config> = {}): Config =>
  ConfigSchema.parse({
    subdomain: 'testsubdomain',
    oauthClientId: 'testsubdomain_zendesk',
    logLevel: 'info',
    mode: 'all',
    readOnly: false,
    transport: 'stdio',
    host: '127.0.0.1',
    port: 0,
    ...overrides,
  });
