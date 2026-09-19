import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTokenStore } from '../../src/auth/token-store';

// The unit suites prove this logic against a mocked `node:fs` and, for the
// store, a mocked persistence module — so between them nothing shows that a
// real process, on a real disk, actually removes the file. That is the gap this
// covers, and the reason it is an integration test rather than a manual step.
//
// Windows only: `configDir` reads %APPDATA% there, not XDG_CONFIG_HOME.
describe.skipIf(process.platform === 'win32')('[stdio] legacy token sweep', () => {
  const SUBDOMAIN = 'acme';
  const CONFIG = { subdomain: SUBDOMAIN, oauthClientId: 'acme_zendesk', readOnly: false };

  let home: string;
  let configDir: string;
  let legacy: string;
  const envBefore = {
    xdg: process.env['XDG_CONFIG_HOME'],
    file: process.env['ZENDESK_TOKEN_FILE'],
  };

  const seedLegacyRecord = () =>
    writeFileSync(
      legacy,
      JSON.stringify({ accessToken: 'stale-access', refreshToken: 'still-live' }),
      'utf8',
    );

  // Start the store the way `index.ts` does and stop its keepalive. No tool call
  // is made, so nothing reaches Zendesk and no browser flow starts.
  const startAndDisposeStore = () => createTokenStore(CONFIG).dispose();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'zendesk-mcp-sweep-'));
    process.env['XDG_CONFIG_HOME'] = home;
    delete process.env['ZENDESK_TOKEN_FILE'];
    configDir = join(home, 'fruggr', 'zendesk-mcp-server');
    mkdirSync(configDir, { recursive: true });
    legacy = join(configDir, `${SUBDOMAIN}.json`);
  });

  afterEach(() => {
    if (envBefore.xdg === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = envBefore.xdg;
    if (envBefore.file === undefined) delete process.env['ZENDESK_TOKEN_FILE'];
    else process.env['ZENDESK_TOKEN_FILE'] = envBefore.file;
    rmSync(home, { recursive: true, force: true });
  });

  it('deletes the pre-rename record from disk when the store starts', () => {
    seedLegacyRecord();

    startAndDisposeStore();

    expect(existsSync(legacy)).toBe(false);
  });

  it('leaves the record alone when ZENDESK_TOKEN_FILE is set', () => {
    seedLegacyRecord();
    // The override can name the legacy file itself, which would make deleting it
    // cost a sign-in on every start.
    process.env['ZENDESK_TOKEN_FILE'] = legacy;

    startAndDisposeStore();

    expect(JSON.parse(readFileSync(legacy, 'utf8'))).toMatchObject({
      accessToken: 'stale-access',
    });
  });

  it('starts cleanly when there is no legacy record, the case for most installs', () => {
    expect(() => startAndDisposeStore()).not.toThrow();
    expect(existsSync(legacy)).toBe(false);
  });
});
