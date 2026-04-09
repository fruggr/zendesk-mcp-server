import { describe, it, expect } from 'vitest';
import { buildBasicAuthHeader } from '../../../src/auth/api-token';

describe('buildBasicAuthHeader', () => {
  it('builds a Basic auth header with email/token format', () => {
    const header = buildBasicAuthHeader('agent@example.com', 'my_api_token');
    expect(header).toMatch(/^Basic /);
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    expect(decoded).toBe('agent@example.com/token:my_api_token');
  });
});
