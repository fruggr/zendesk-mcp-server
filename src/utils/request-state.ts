import { randomBytes } from 'node:crypto';
import {
  type RequestStateCodec,
  createRequestStateCodec as sdkCodec,
} from '@modelcontextprotocol/server';

export interface RequestStateCodecOptions {
  /**
   * HMAC key, at least 32 bytes. Every process that may receive an echoed
   * state needs the same key; omitted, a random one is drawn, which suits a
   * server whose rounds all reach this process (stdio).
   */
  key?: Uint8Array;
  /** Who the state belongs to (the grant on HTTP), read at mint and at verify. */
  principal?: () => string;
}

/**
 * `requestState` round-trips through the client, so it comes back as
 * attacker-controlled input: the spec requires integrity protection and binding
 * to the user. Every server verifies it with this codec (`requestState.verify`)
 * and handlers mint state only through it. Bound to the method and the
 * principal, so state minted for one grant or one method is refused elsewhere.
 */
export const createRequestStateCodec = ({
  key = randomBytes(32),
  principal = () => '',
}: RequestStateCodecOptions): RequestStateCodec =>
  sdkCodec({ key, bind: (ctx) => `${ctx.mcpReq.method}\0${principal()}` });
