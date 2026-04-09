import { describe, it, expect } from 'vitest';
import { createMcpServer } from '../../src/server';
import type { Config } from '../../src/config';

const baseConfig: Config = {
  subdomain: 'testsubdomain',
  oauthClientId: 'test_zendesk',
  logLevel: 'info',
  mode: 'all',
  readOnly: false,
};

const getToken = () => 'test-token';

describe('createMcpServer', () => {
  it('creates a server in all mode', () => {
    const server = createMcpServer({ ...baseConfig, mode: 'all' }, getToken);
    expect(server).toBeDefined();
  });

  it('creates a server in namespace mode', () => {
    const server = createMcpServer({ ...baseConfig, mode: 'namespace' }, getToken);
    expect(server).toBeDefined();
  });

  it('creates a server in single mode', () => {
    const server = createMcpServer({ ...baseConfig, mode: 'single' }, getToken);
    expect(server).toBeDefined();
  });

  it('creates a server with readOnly filter', () => {
    const server = createMcpServer({ ...baseConfig, readOnly: true }, getToken);
    expect(server).toBeDefined();
  });

  it('creates a server with namespace filter', () => {
    const server = createMcpServer(
      { ...baseConfig, namespaces: ['tickets'] },
      getToken,
    );
    expect(server).toBeDefined();
  });

  it('creates a server with tool filter', () => {
    const server = createMcpServer(
      { ...baseConfig, mode: 'all', tools: ['get_ticket', 'get_current_user'] },
      getToken,
    );
    expect(server).toBeDefined();
  });
});
