import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Runs the `PostToolUse` command from `.claude/settings.json` the way Claude
 * Code does: hook input as JSON on stdin, `CLAUDE_PROJECT_DIR` in the env. The
 * project is a scratch copy whose `scripts/biome.mjs` only records its argv, so
 * what is asserted is exactly what Biome would have been handed.
 *
 * Nothing else catches a broken wiring: the hook ends in `|| exit 0`, so a
 * command that lints the wrong files, or none, still looks green (issue #374).
 */

const repoRoot = new URL('../../', import.meta.url);
const settings = JSON.parse(readFileSync(new URL('.claude/settings.json', repoRoot), 'utf8')) as {
  hooks: { PostToolUse: { matcher: string; hooks: { command: string }[] }[] };
};
const editHook = settings.hooks.PostToolUse.find((h) => h.matcher === 'Edit|Write');
const command = editHook?.hooks[0]?.command ?? '';

const FAKE_BIOME = `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.BIOME_EXIT ?? 0));
`;

let sandbox: string;
let project: string;
let argvLog: string;

const runHook = (input: unknown, env: Record<string, string> = {}) =>
  execFileSync('sh', ['-c', command], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, ARGV_LOG: argvLog, ...env },
    cwd: sandbox,
    encoding: 'utf8',
  });

const biomeArgv = (): string[] | undefined =>
  existsSync(argvLog) ? (JSON.parse(readFileSync(argvLog, 'utf8')) as string[]) : undefined;

const edited = (relative: string) => {
  const path = join(project, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'export const a = 1;\n');
  return path;
};

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'lint-hook-')));
  project = join(sandbox, 'my project');
  argvLog = join(sandbox, 'argv.json');
  mkdirSync(join(project, 'scripts'), { recursive: true });
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(project, 'scripts', 'biome.mjs'), FAKE_BIOME);
  copyFileSync(
    new URL('.claude/hooks/lint-edited-file.sh', repoRoot),
    join(project, '.claude', 'hooks', 'lint-edited-file.sh'),
  );
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('PostToolUse lint hook (.claude/settings.json)', () => {
  it('reads the edited path from stdin, not from an environment variable', () => {
    expect(command).not.toContain('CLAUDE_FILE_PATHS');
  });

  it('hands Biome exactly the edited file, after the end-of-options marker', () => {
    const file = edited('src/a.ts');
    runHook({ tool_name: 'Edit', tool_input: { file_path: file } });
    expect(biomeArgv()).toEqual([
      'lint',
      '--write',
      '--skip=types',
      '--no-errors-on-unmatched',
      '--',
      file,
    ]);
  });

  it('keeps a path with spaces and shell metacharacters as one inert argument', () => {
    const file = edited('src/$(touch pwned) `touch pwned2`; a b.ts');
    runHook({ tool_name: 'Write', tool_input: { file_path: file } });
    expect(biomeArgv()?.at(-1)).toBe(file);
    expect(existsSync(join(sandbox, 'pwned'))).toBe(false);
    expect(existsSync(join(sandbox, 'pwned2'))).toBe(false);
  });

  it('passes a path starting with a dash as a path, not an option', () => {
    const file = edited('-a.ts');
    runHook({ tool_input: { file_path: file } });
    expect(biomeArgv()?.slice(-2)).toEqual(['--', file]);
  });

  it('does not run Biome when the input carries no file path', () => {
    runHook({ tool_input: {} });
    runHook('not json');
    expect(biomeArgv()).toBeUndefined();
  });

  it('does not run Biome on a file outside the project', () => {
    const outside = join(sandbox, 'outside.ts');
    writeFileSync(outside, 'export const a = 1;\n');
    runHook({ tool_input: { file_path: outside } });
    expect(biomeArgv()).toBeUndefined();
  });

  it('does not run Biome on a path that escapes the project through ..', () => {
    writeFileSync(join(sandbox, 'outside.ts'), 'export const a = 1;\n');
    mkdirSync(join(project, 'src'));
    // Template string, not join(): join() would normalise the `..` away.
    runHook({ tool_input: { file_path: `${project}/src/../../outside.ts` } });
    expect(biomeArgv()).toBeUndefined();
  });

  it('does not mistake a sibling directory sharing the project prefix for the project', () => {
    const sibling = `${project}-evil`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'a.ts'), 'export const a = 1;\n');
    runHook({ tool_input: { file_path: join(sibling, 'a.ts') } });
    expect(biomeArgv()).toBeUndefined();
  });

  it('does not run Biome through a symlink that points outside the project', () => {
    const outside = join(sandbox, 'outside.ts');
    writeFileSync(outside, 'export const a = 1;\n');
    mkdirSync(join(project, 'src'));
    symlinkSync(outside, join(project, 'src', 'link.ts'));
    symlinkSync(sandbox, join(project, 'escape'));
    runHook({ tool_input: { file_path: join(project, 'src', 'link.ts') } });
    runHook({ tool_input: { file_path: join(project, 'escape', 'outside.ts') } });
    expect(biomeArgv()).toBeUndefined();
  });

  it('resolves .. after a symlinked directory the way the kernel does', () => {
    // The kernel reads project/deep/../x.ts as sandbox/a/x.ts; a logical `cd`
    // would read it as project/x.ts and let the write through.
    mkdirSync(join(sandbox, 'a', 'b'), { recursive: true });
    writeFileSync(join(sandbox, 'a', 'x.ts'), 'export const a = 1;\n');
    symlinkSync(join(sandbox, 'a', 'b'), join(project, 'deep'));
    runHook({ tool_input: { file_path: `${project}/deep/../x.ts` } });
    expect(biomeArgv()).toBeUndefined();
  });

  it('never blocks the edit when Biome reports a violation', () => {
    const file = edited('src/a.ts');
    expect(() => runHook({ tool_input: { file_path: file } }, { BIOME_EXIT: '1' })).not.toThrow();
    expect(biomeArgv()).toBeDefined();
  });
});
