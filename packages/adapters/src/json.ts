import type { Adapter, PulledResource, PushResource } from '@opendeepl/sdk';
import { readTextIfExists, toFileLocale, writeText } from './files';

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

const sortedJson = (data: Record<string, string>): string =>
  `${JSON.stringify(Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;

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
      await writeText(options.root, path, sortedJson(next));
      files.push(path);
    }
    return { written, files };
  },
});

