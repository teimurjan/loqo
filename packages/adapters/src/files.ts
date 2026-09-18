import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type FileAdapterOptions = {
  /** Repository checkout the adapter reads and writes. */
  root: string;
  /** Glob patterns, relative to `root`: `**` spans directories, `*` and `?` stay within one segment. */
  include: string[];
  /** Path prefixes to skip (e.g. `Tools`, `androidApp/src/demo`). */
  ignore?: string[];
  /** Platform locale → file locale (`zh-hans` → `zh-Hans`). Identity when absent. */
  localeMap?: Record<string, string>;
};

/** Never worth descending into, whatever the patterns say. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);

const escapeRegExp = (value: string): string => value.replace(/[.+^${}()|[\]\\]/g, '\\$&');

export const globToRegExp = (pattern: string): RegExp => {
  const segments = pattern.split('/');
  const source = segments
    .map((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === '**') return last ? '.*' : '(?:.*/)?';
      const body = escapeRegExp(segment).replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
      return last ? body : `${body}/`;
    })
    .join('');
  return new RegExp(`^${source}$`);
};

const isIgnored = (path: string, ignore: string[]): boolean =>
  ignore.some((prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.includes(`/${prefix}/`));

const walk = async (root: string, directory: string, ignore: string[], found: string[]): Promise<void> => {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isFile()) {
      found.push(path);
    } else if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name) && !isIgnored(path, ignore)) {
      await walk(root, path, ignore, found);
    }
  }
};

/** Files under `root` matching any `include` pattern, as sorted root-relative paths. */
export const discoverFiles = async (options: FileAdapterOptions): Promise<string[]> => {
  const patterns = options.include.map(globToRegExp);
  const found: string[] = [];
  await walk(options.root, '', options.ignore ?? [], found);
  return found.filter((path) => patterns.some((pattern) => pattern.test(path))).sort();
};

export const readText = (root: string, path: string): Promise<string> => readFile(join(root, path), 'utf8');

/** `null` when the file does not exist; any other failure propagates. */
export const readTextIfExists = async (root: string, path: string): Promise<string | null> => {
  try {
    return await readText(root, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

export const writeText = async (root: string, path: string, content: string): Promise<void> => {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
};

export const toFileLocale = (locale: string, localeMap: Record<string, string> = {}): string =>
  localeMap[locale] ?? locale;

/** Stable JSON key for composite resource identities: the parts sorted by name, so every producer spells it the same. */
export const compositeKey = (parts: Record<string, string | number | undefined>): string => {
  const defined = Object.fromEntries(Object.entries(parts).filter(([, value]) => value !== undefined));
  return JSON.stringify(defined, Object.keys(defined).sort());
};

export const parseCompositeKey = (key: string): Record<string, string | number> | null => {
  try {
    const parsed: unknown = JSON.parse(key);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string | number>)
      : null;
  } catch {
    return null;
  }
};
