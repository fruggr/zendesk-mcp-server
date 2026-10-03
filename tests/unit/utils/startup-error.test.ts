import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createStartupError,
  errnoCode,
  isStartupError,
  STARTUP_DOCS,
} from '../../../src/utils/startup-error';

// GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens.
const anchorsOf = (markdown: string): Set<string> =>
  new Set(
    [...markdown.matchAll(/^#{1,6} (.+)$/gm)].map(([, title = '']) =>
      title
        .toLowerCase()
        .replace(/[^\w\- ]/g, '')
        .replaceAll(' ', '-'),
    ),
  );

describe('STARTUP_DOCS', () => {
  it.each(Object.entries(STARTUP_DOCS))('%s links a section that exists on main', (_, url) => {
    const { pathname, hash } = new URL(url);
    expect(pathname).toMatch(/^\/fruggr\/zendesk-mcp-server\/blob\/main\/docs\//);
    const file = pathname.replace('/fruggr/zendesk-mcp-server/blob/main/', '');
    expect(anchorsOf(readFileSync(file, 'utf8'))).toContain(hash.slice(1));
  });
});

describe('createStartupError', () => {
  it('ends the message with the docs link and keeps the cause', () => {
    const cause = new Error('EROFS');
    const err = createStartupError('Cannot write here.', STARTUP_DOCS.secretAndStore, cause);
    expect(err.message).toBe(
      'Cannot write here. See https://github.com/fruggr/zendesk-mcp-server/blob/main/docs/http-deployment.md#master-secret-and-grant-store',
    );
    expect(err.cause).toBe(cause);
    expect(err.docs).toBe(STARTUP_DOCS.secretAndStore);
    expect(isStartupError(err)).toBe(true);
  });

  it('tells a startup error from any other error', () => {
    expect(isStartupError(new Error('boom'))).toBe(false);
    expect(isStartupError(Object.assign(new Error('x'), { name: 'StartupError' }))).toBe(false);
    expect(isStartupError({ name: 'StartupError', docs: 'x', message: 'x' })).toBe(false);
  });
});

describe('errnoCode', () => {
  it('names the errno code, or says it has none', () => {
    expect(errnoCode(Object.assign(new Error('x'), { code: 'EROFS' }))).toBe('EROFS');
    expect(errnoCode(new Error('x'))).toBe('unknown error');
    expect(errnoCode(undefined)).toBe('unknown error');
  });
});
