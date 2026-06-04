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
