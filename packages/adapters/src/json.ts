import type { Adapter, PulledResource, PushResource } from '@loqo/sdk';
import { readTextIfExists, toFileLocale, writeText } from './files';

/** How a written file lays its keys out. */
export type JsonKeyOrder = 'codepoint' | 'preserve';

export type JsonOptions = {
  root: string;
  /** Source file relative to `root`, e.g. `public/locales/en/common.json`. */
  source: string;
  /** Where a locale's file lives; `{locale}` is substituted. Defaults to the source path with the source locale swapped. */
  target?: string;
  sourceLocale?: string;
  localeMap?: Record<string, string>;
  /** Tags applied to every resource; `webapp` enables the ICU plural prompt and guard. */
  tags?: string[];
  /** `codepoint` (default) sorts every file the same way; `preserve` keeps the file's own order and appends what is new. */
  sort?: JsonKeyOrder;
};

const targetPath = (options: JsonOptions, locale: string): string => {
  const fileLocale = toFileLocale(locale, options.localeMap);
  if (options.target) return options.target.replaceAll('{locale}', fileLocale);
  const sourceLocale = options.sourceLocale ?? 'en';
  return options.source.replace(`/${sourceLocale}/`, `/${fileLocale}/`);
};

const readJson = async (root: string, path: string): Promise<Record<string, string>> => {
  const text = await readTextIfExists(root, path);
  if (text === null) return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a flat { key: string } object`);
  }
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<
    string,
    string
  >;
};

/** Codepoint, not `localeCompare`: a sorted file's key order must not shift with the runner's locale data. */
const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `preserve` writes the file's own keys first, in the order they were already in, then what the source adds. */
const orderedKeys = (data: Record<string, string>, order: JsonKeyOrder, existing: string[], source: string[]): string[] => {
  const keys = Object.keys(data);
  if (order !== 'preserve') return keys.sort(byCodepoint);
  const placed = new Set<string>();
  const ordered: string[] = [];
  for (const key of [...existing, ...source]) {
    if (!(key in data) || placed.has(key)) continue;
    placed.add(key);
    ordered.push(key);
  }
  return [...ordered, ...keys.filter((key) => !placed.has(key)).sort(byCodepoint)];
};

const toJson = (data: Record<string, string>, keys: string[]): string =>
  `${JSON.stringify(Object.fromEntries(keys.map((key) => [key, data[key]])), null, 2)}\n`;

/** Flat `{ key: string }` locale files (webapp / ucc). */
export const json = (options: JsonOptions): Adapter => ({
  name: 'json',

  async pull({ project }) {
    const source = await readJson(options.root, options.source);
    const existing = new Map<string, Record<string, string>>();
    for (const locale of project.targetLocales) {
      existing.set(locale, await readJson(options.root, targetPath(options, locale)));
    }
    const resources: PulledResource[] = Object.entries(source).map(([key, value]) => ({
      key,
      source: value,
      tags: options.tags ?? ['webapp'],
      meta: {},
      targets: Object.fromEntries(
        project.targetLocales.map((locale) => [locale, existing.get(locale)?.[key]]).filter(([, v]) => v?.trim()),
      ) as Record<string, string>,
    }));
    return { resources };
  },

  async push({ project }, resources: PushResource[]) {
    const order = options.sort ?? 'codepoint';
    const sourceKeys = order === 'preserve' ? Object.keys(await readJson(options.root, options.source)) : [];
    let written = 0;
    const files: string[] = [];
    for (const locale of project.targetLocales) {
      const path = targetPath(options, locale);
      const current = await readJson(options.root, path);
      const next = { ...current };
      for (const resource of resources) {
        const value = resource.targets[locale]?.value;
        if (value) {
          next[resource.key] = value;
          written += 1;
        }
      }
      await writeText(options.root, path, toJson(next, orderedKeys(next, order, Object.keys(current), sourceKeys)));
      files.push(path);
    }
    return { written, files };
  },
});

