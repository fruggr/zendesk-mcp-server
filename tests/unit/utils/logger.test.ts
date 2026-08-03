import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, silentLogger } from '../../../src/utils/logger';

describe('createLogger', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it('writes to stderr at or above the configured level', () => {
    const log = createLogger('info');
    log.debug('skipped_event');
    log.info('kept_event');

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain('kept_event');
  });

  it('suppresses everything below the configured level', () => {
    const log = createLogger('error');
    log.debug('a');
    log.info('b');
    log.warn('c');
    expect(errSpy).not.toHaveBeenCalled();

    log.error('boom');
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it('includes structured fields in the output', () => {
    const log = createLogger('debug');
    log.info('evt', { platform: 'win32', port: 3000 });

    const line = errSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain('evt');
    expect(line).toContain('platform=win32');
    expect(line).toContain('port=3000');
  });

  it('redacts sensitive field values but keeps technical fields', () => {
    const log = createLogger('debug');
    log.error('oauth_failed', {
      token: 'super-secret',
      access_token: 'aaa',
      code: 'the-code',
      errorCode: 'ENOENT',
      status: 401,
    });

    const line = errSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain('super-secret');
    expect(line).not.toContain('aaa');
    expect(line).not.toContain('the-code');
    expect(line).toContain('[REDACTED]');
    // Diagnostic, non-sensitive fields must survive.
    expect(line).toContain('ENOENT');
    expect(line).toContain('status=401');
  });

  it('redacts sensitive values nested in objects and arrays', () => {
    const log = createLogger('debug');
    log.error('nested', {
      oauth: { access_token: 'deep-secret' },
      items: [{ token: 'arr-secret', label: 'keep-me' }],
    });

    const line = errSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain('deep-secret');
    expect(line).not.toContain('arr-secret');
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('keep-me');
  });

  it('collapses a circular reference instead of blowing the stack', () => {
    const log = createLogger('debug');
    const circular: Record<string, unknown> = { label: 'root' };
    circular.self = circular;

    expect(() => log.info('evt', { circular })).not.toThrow();

    const line = errSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain('evt');
    expect(line).toContain('[circular]');
    expect(line).toContain('root');
  });

  it('still redacts sensitive keys inside a cycle', () => {
    const log = createLogger('debug');
    const node: Record<string, unknown> = { token: 'cyclic-secret' };
    node.self = node;

    log.error('cyclic', { node });

    const line = errSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain('cyclic-secret');
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('[circular]');
  });

  it('marks only true cycles, not values shared between siblings', () => {
    const log = createLogger('debug');
    const shared = { label: 'shared-value' };

    log.info('dag', { a: shared, b: shared });

    const line = errSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain('[circular]');
    expect(line).toContain('a={"label":"shared-value"}');
    expect(line).toContain('b={"label":"shared-value"}');
  });

  it('forwards the same sanitised payload to the MCP sink for a circular value', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const log = createLogger('debug');
    log.attachServer({ sendLoggingMessage: send } as never);

    const node: Record<string, unknown> = { token: 'cyclic-secret' };
    node.self = node;

    expect(() => log.warn('cyclic', { node })).not.toThrow();

    const arg = send.mock.calls[0]?.[0] as {
      data: { node: { token: string; self: string } };
    };
    expect(arg.data.node.token).toBe('[REDACTED]');
    expect(arg.data.node.self).toBe('[circular]');
    // The payload must be a finite tree the transport can serialise.
    expect(() => JSON.stringify(arg.data)).not.toThrow();
  });

  it('neutralises a caller-supplied toJSON that would re-expose a redacted value', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const log = createLogger('debug');
    log.attachServer({ sendLoggingMessage: send } as never);

    // The walk redacts `token`, but an own enumerable `toJSON` copied into the
    // sanitised tree would be invoked by JSON.stringify and hand back the
    // original, unredacted object.
    const hostile = {
      token: 'tojson-secret',
      toJSON: () => ({ token: 'tojson-secret' }),
    };

    log.error('hostile_tojson', { hostile });

    const line = errSpy.mock.calls[0]?.[0] as string;
    expect(line).not.toContain('tojson-secret');
    expect(line).toContain('[REDACTED]');

    const arg = send.mock.calls[0]?.[0] as { data: unknown };
    expect(JSON.stringify(arg.data)).not.toContain('tojson-secret');
  });

  it('does not throw when a field getter throws during redaction', () => {
    const log = createLogger('debug');
    const hostile = {
      get boom(): never {
        throw new Error('getter exploded');
      },
    };

    expect(() => log.info('hostile', { hostile })).not.toThrow();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0] as string).toContain('hostile');
  });

  it('does not throw when the stderr write itself fails', () => {
    errSpy.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    const log = createLogger('debug');

    expect(() => log.info('x', { a: 1 })).not.toThrow();
  });

  it('keeps the canonical event name even if a field named "event" is passed', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const log = createLogger('debug');
    log.attachServer({ sendLoggingMessage: send } as never);

    log.info('real_event', { event: 'spoofed' });

    const arg = send.mock.calls[0]?.[0] as { data: { event: string } };
    expect(arg.data.event).toBe('real_event');
  });

  it('forwards to the MCP server when attached, mapping warn -> warning', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const log = createLogger('debug');
    log.attachServer({ sendLoggingMessage: send } as never);

    log.warn('w', { a: 1, token: 'x' });

    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0]?.[0] as {
      level: string;
      data: { event: string; token: string };
    };
    expect(arg.level).toBe('warning');
    expect(arg.data.event).toBe('w');
    // Redaction applies to the MCP sink too.
    expect(arg.data.token).toBe('[REDACTED]');
  });

  it('does not throw when the MCP forward rejects', () => {
    const send = vi.fn().mockRejectedValue(new Error('not connected'));
    const log = createLogger('debug');
    log.attachServer({ sendLoggingMessage: send } as never);

    expect(() => log.info('x')).not.toThrow();
  });

  it('exposes a silent logger that never writes', () => {
    silentLogger.debug('a');
    silentLogger.info('b');
    silentLogger.warn('c');
    silentLogger.error('d');
    silentLogger.attachServer({ sendLoggingMessage: vi.fn() } as never);

    expect(errSpy).not.toHaveBeenCalled();
  });
});
