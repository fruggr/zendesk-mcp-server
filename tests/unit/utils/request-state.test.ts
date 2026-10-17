import type { ServerContext } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createRequestStateCodec } from '../../../src/utils/request-state';

const ctx = (method: string): ServerContext => ({ mcpReq: { method } }) as unknown as ServerContext;

describe('createRequestStateCodec', () => {
  it('verifies the state it minted, for the same method and principal', async () => {
    const codec = createRequestStateCodec({ principal: () => 'grant-a' });
    const state = await codec.mint({ step: 2 }, ctx('tools/call'));

    await expect(codec.verify(state, ctx('tools/call'))).resolves.toEqual({ step: 2 });
  });

  it('refuses state minted for another principal', async () => {
    let principal = 'grant-a';
    const codec = createRequestStateCodec({ principal: () => principal });
    const state = await codec.mint({ step: 2 }, ctx('tools/call'));

    principal = 'grant-b';

    await expect(codec.verify(state, ctx('tools/call'))).rejects.toThrow('bind');
  });

  it('refuses state minted for another method', async () => {
    const codec = createRequestStateCodec({ principal: () => 'grant-a' });
    const state = await codec.mint({ step: 2 }, ctx('tools/call'));

    await expect(codec.verify(state, ctx('prompts/get'))).rejects.toThrow('bind');
  });

  it('refuses tampered state', async () => {
    const codec = createRequestStateCodec({});
    const state = await codec.mint({ step: 2 }, ctx('tools/call'));
    const tampered = `${state.slice(0, -2)}${state.endsWith('A') ? 'BB' : 'AA'}`;

    await expect(codec.verify(tampered, ctx('tools/call'))).rejects.toThrow();
  });

  it('draws a fresh random key when none is given', async () => {
    const minted = await createRequestStateCodec({}).mint({ step: 2 }, ctx('tools/call'));

    await expect(createRequestStateCodec({}).verify(minted, ctx('tools/call'))).rejects.toThrow(
      'mac',
    );
  });

  it('shares state between codecs built from the same key', async () => {
    const key = new Uint8Array(32).fill(7);
    const minted = await createRequestStateCodec({ key }).mint({ step: 2 }, ctx('tools/call'));

    await expect(
      createRequestStateCodec({ key }).verify(minted, ctx('tools/call')),
    ).resolves.toEqual({ step: 2 });
  });

  it('treats a missing principal as the empty one', async () => {
    const key = new Uint8Array(32).fill(7);
    const minted = await createRequestStateCodec({ key, principal: () => '' }).mint(
      { step: 2 },
      ctx('tools/call'),
    );

    await expect(
      createRequestStateCodec({ key }).verify(minted, ctx('tools/call')),
    ).resolves.toEqual({ step: 2 });
  });
});
