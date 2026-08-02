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

    // Pinned in full rather than by fragments: the prefix, the bracketed level
    // and the ` `/`=` separators are the whole contract of a line that humans
    // and log scrapers read.
    expect(errSpy.mock.calls[0]?.[0]).toBe('[zendesk-mcp] [info] evt platform=win32 port=3000');
  });

  it('emits the bare event with no trailing separator when there are no fields', () => {
    const log = createLogger('debug');
    log.info('evt');

    expect(errSpy.mock.calls[0]?.[0]).toBe('[zendesk-mcp] [info] evt');
  });

  it('labels each line with its own level', () => {
    const log = createLogger('debug');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(errSpy.mock.calls.map((call) => call[0])).toEqual([
      '[zendesk-mcp] [debug] d',
      '[zendesk-mcp] [info] i',
      '[zendesk-mcp] [warn] w',
      '[zendesk-mcp] [error] e',
    ]);
  });

  it('renders booleans, null and undefined field values', () => {
    const log = createLogger('debug');
    log.info('evt', { enabled: true, disabled: false, missing: null, absent: undefined });

    expect(errSpy.mock.calls[0]?.[0]).toBe(
      '[zendesk-mcp] [info] evt enabled=true disabled=false missing=null absent=undefined',
    );
  });

  it('falls back to a placeholder for values JSON cannot serialize', () => {
    // A BigInt makes JSON.stringify throw while staying a primitive, so it
    // reaches renderValue's guard. NOTE: a *circular* object does not — it
    // blows the stack inside redactValue first. See the follow-up issue linked
    // in the PR description; not fixed here to keep this branch test-only.
    const log = createLogger('debug');
    log.info('evt', { big: 10n });

    expect(errSpy.mock.calls[0]?.[0]).toBe('[zendesk-mcp] [info] evt big=[unserializable]');
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

  it('matches sensitive keys regardless of case and separators', () => {
    // The key set is normalised (lowercased, `_`/`-` stripped) precisely so
    // these spellings collapse onto the same entry. Nothing pinned that.
    const log = createLogger('debug');
    log.error('oauth_failed', {
      'ACCESS-TOKEN': 'hyphen-upper',
      refreshToken: 'camel',
      Code_Verifier: 'mixed',
    });

    expect(errSpy.mock.calls[0]?.[0]).toBe(
      '[zendesk-mcp] [error] oauth_failed ACCESS-TOKEN=[REDACTED] refreshToken=[REDACTED] Code_Verifier=[REDACTED]',
    );
  });

  it('leaves a key that merely contains a sensitive word alone', () => {
    // The match is on the whole normalised key, not a substring: `tokenCount`
    // is a metric, not a credential.
    const log = createLogger('debug');
    log.info('stats', { tokenCount: 42, secretsScanned: 3 });

    expect(errSpy.mock.calls[0]?.[0]).toBe(
      '[zendesk-mcp] [info] stats tokenCount=42 secretsScanned=3',
    );
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

  it('keeps arrays as arrays rather than reshaping them into objects', () => {
    // Redaction walks arrays element-wise; treating one as a plain object
    // would turn `[a, b]` into `{"0":a,"1":b}` in the rendered line.
    const log = createLogger('debug');
    log.info('evt', { scopes: ['read', 'write'] });

    expect(errSpy.mock.calls[0]?.[0]).toBe('[zendesk-mcp] [info] evt scopes=["read","write"]');
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

  it('maps every level onto its MCP counterpart', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const log = createLogger('debug');
    log.attachServer({ sendLoggingMessage: send } as never);

    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    // Only `warn -> warning` was pinned; the identity mappings were not, so a
    // typo in any of the other three would have gone unnoticed.
    expect(send.mock.calls.map((call) => (call[0] as { level: string }).level)).toEqual([
      'debug',
      'info',
      'warning',
      'error',
    ]);
  });

  it('tags every MCP notification with the server logger name', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const log = createLogger('debug');
    log.attachServer({ sendLoggingMessage: send } as never);

    log.info('x');

    expect(send.mock.calls[0]?.[0]).toMatchObject({ logger: 'zendesk-mcp-server' });
  });

  it('does not throw when the MCP forward rejects', () => {
    const send = vi.fn().mockRejectedValue(new Error('not connected'));
    const log = createLogger('debug');
    log.attachServer({ sendLoggingMessage: send } as never);

    expect(() => log.info('x')).not.toThrow();
  });

  it('does not throw when the MCP forward throws synchronously', () => {
    // A transport that is not connected yet can reject before returning a
    // promise at all — the `try` around the call is what covers that, and it
    // was untested.
    const send = vi.fn(() => {
      throw new Error('transport not connected');
    });
    const log = createLogger('debug');
    log.attachServer({ sendLoggingMessage: send } as never);

    expect(() => log.info('x')).not.toThrow();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it('writes to stderr even when no server is attached', () => {
    const log = createLogger('debug');
    log.info('standalone');

    expect(errSpy.mock.calls[0]?.[0]).toBe('[zendesk-mcp] [info] standalone');
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
