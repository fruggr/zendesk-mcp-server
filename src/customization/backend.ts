import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Who changed an entry, and when: shown to admins, and a Git backend's commit author. */
export interface ChangeAuthor {
  readonly name: string;
  /** ISO 8601. */
  readonly at: string;
}

/** One file of the tree: its new text, or `null` to remove it. */
export interface FileChange {
  readonly path: string;
  readonly content: string | null;
}

export interface StoredTree {
  /** Relative `/`-separated path → UTF-8 text. */
  readonly files: ReadonlyMap<string, string>;
  /** Last change per path, for the paths the backend has a record of. */
  readonly authors: ReadonlyMap<string, ChangeAuthor>;
}

/**
 * Where the customizations live: a tree of text files, read whole and changed
 * by change sets. A file tree on purpose, so a Git backend is a commit per
 * change set (docs/decisions/customizations.md).
 */
export interface CustomizationBackend {
  load(): Promise<StoredTree>;
  /** Applies every change, then records `author` for each path. */
  apply(changes: readonly FileChange[], author: ChangeAuthor): Promise<void>;
}

const AUTHORS_FILE = '.authors.json';
// What `writeAtomic` names its temp files: a skill's own `notes.tmp` stays an entry.
const TEMP_FILE = /\.[0-9a-f-]{36}\.tmp$/;

/** Nothing on disk: tests, and `memory://` deployments that accept losing it on restart. */
export const createMemoryBackend = (seed: Record<string, string> = {}): CustomizationBackend => {
  const files = new Map(Object.entries(seed));
  const authors = new Map<string, ChangeAuthor>();
  return {
    load: async () => ({ files: new Map(files), authors: new Map(authors) }),
    apply: async (changes, author) => {
      for (const { path, content } of changes) {
        if (content === null) {
          files.delete(path);
          authors.delete(path);
        } else {
          files.set(path, content);
          authors.set(path, author);
        }
      }
    },
  };
};

const listFiles = async (root: string, dir = ''): Promise<string[]> => {
  const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    },
  );
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) return listFiles(root, path);
      // Temp files of an interrupted write, and the authors record, are not entries.
      return entry.isFile() && !TEMP_FILE.test(entry.name) && path !== AUTHORS_FILE ? [path] : [];
    }),
  );
  return nested.flat();
};

const writeAtomic = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, path);
};

/**
 * One Markdown file per entry under `root`, readable and versionable as is; the
 * authors live beside them in `.authors.json`. Each file is replaced by a
 * rename, so a reader never sees half of one.
 */
export const createFileBackend = (dir: string): CustomizationBackend => {
  const root = resolve(dir);
  const authorsPath = join(root, AUTHORS_FILE);
  const readAuthors = async (): Promise<Record<string, ChangeAuthor>> => {
    try {
      return JSON.parse(await readFile(authorsPath, 'utf8')) as Record<string, ChangeAuthor>;
    } catch {
      // Missing or unreadable: the entries stay served, only who changed them is lost.
      return {};
    }
  };
  const resolvePath = (path: string): string => join(root, ...path.split('/'));
  return {
    load: async () => {
      const paths = await listFiles(root);
      const files = new Map(
        await Promise.all(
          paths.map(async (path) => [path, await readFile(resolvePath(path), 'utf8')] as const),
        ),
      );
      return { files, authors: new Map(Object.entries(await readAuthors())) };
    },
    apply: async (changes, author) => {
      const authors = await readAuthors();
      for (const { path, content } of changes) {
        const target = resolvePath(path);
        // The model validates every path; this only refuses one escaping the root.
        if (!target.startsWith(`${root}${sep}`)) throw new Error(`Invalid path: ${path}`);
        if (content === null) {
          await rm(target, { force: true });
          delete authors[path];
        } else {
          await writeAtomic(target, content);
          authors[path] = author;
        }
      }
      await writeAtomic(authorsPath, `${JSON.stringify(authors, null, 2)}\n`);
    },
  };
};

/** `file://<dir>` or `memory://`, as `CUSTOMIZATION_STORE` names it. */
export const openCustomizationBackend = (uri: string): CustomizationBackend => {
  const url = new URL(uri);
  if (url.protocol === 'memory:') return createMemoryBackend();
  if (url.protocol === 'file:') return createFileBackend(fileURLToPath(url));
  throw new Error(
    `Unsupported CUSTOMIZATION_STORE "${url.protocol}//": use file://<directory> or memory://.`,
  );
};
