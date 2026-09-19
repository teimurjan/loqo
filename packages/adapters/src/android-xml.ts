import { basename, dirname, join } from 'node:path';
import { type Adapter, pluralCategories, type PulledResource, type PushResource } from '@loqo/sdk';
import {
  compositeKey,
  discoverFiles,
  type FileAdapterOptions,
  parseCompositeKey,
  readText,
  readTextIfExists,
  toFileLocale,
  writeText,
} from './files';

export type AndroidXmlOptions = Omit<FileAdapterOptions, 'include'> & { include?: string[] };

type Attributes = Record<string, string>;

const parseAttributes = (raw: string): Attributes =>
  Object.fromEntries([...raw.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name ?? '', value ?? '']));

// Comments and elements are matched in one left-to-right pass so a `<string` inside a comment is
// skipped. `<string` is followed by a lookahead rather than `\b`, which would also match `<string-array`.
const ELEMENT_SCAN =
  /<!--[\s\S]*?-->|<string(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/string>)|<plurals\b([^>]*)>([\s\S]*?)<\/plurals>|<string-array\b([^>]*)>([\s\S]*?)<\/string-array>/g;
const ITEM_SCAN = /<item\b([^>]*)>([\s\S]*?)<\/item>/g;

type ParsedResource =
  | { kind: 'string'; name: string; attrs: Attributes; value: string }
  | { kind: 'plurals'; name: string; attrs: Attributes; items: { quantity: string; value: string }[] }
  | { kind: 'string-array'; name: string; attrs: Attributes; items: string[] };

/** Inner content is kept raw: xliff wrappers, entities and inline tags are part of the value. */
export const parseAndroidResources = (xml: string): ParsedResource[] => {
  const parsed: ParsedResource[] = [];
  for (const match of xml.matchAll(ELEMENT_SCAN)) {
    const [, stringAttrs, stringValue, pluralAttrs, pluralBody, arrayAttrs, arrayBody] = match;
    if (stringAttrs !== undefined) {
      const attrs = parseAttributes(stringAttrs);
      if (attrs.name) parsed.push({ kind: 'string', name: attrs.name, attrs, value: stringValue ?? '' });
    } else if (pluralAttrs !== undefined) {
      const attrs = parseAttributes(pluralAttrs);
      const items = [...(pluralBody ?? '').matchAll(ITEM_SCAN)].map(([, itemAttrs, value]) => ({
        quantity: parseAttributes(itemAttrs ?? '').quantity ?? 'other',
        value: value ?? '',
      }));
      if (attrs.name) parsed.push({ kind: 'plurals', name: attrs.name, attrs, items });
    } else if (arrayAttrs !== undefined) {
      const attrs = parseAttributes(arrayAttrs);
      const items = [...(arrayBody ?? '').matchAll(ITEM_SCAN)].map(([, , value]) => value ?? '');
      if (attrs.name) parsed.push({ kind: 'string-array', name: attrs.name, attrs, items });
    }
  }
  return parsed;
};

const PLURAL_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];

/** Plain code-point order, the same `Array.prototype.sort()` the old import action used. */
const byCodePoint = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every CLDR category any target locale uses beyond the source's own. */
const synthesizedQuantities = (project: { sourceLocale: string; targetLocales: string[] }): string[] => {
  const source = pluralCategories(project.sourceLocale);
  const all = new Set<string>();
  for (const locale of project.targetLocales) for (const category of pluralCategories(locale)) all.add(category);
  return PLURAL_ORDER.filter((quantity) => all.has(quantity) && !source.has(quantity));
};

/** Markup Android renders in any string resource; a source may add more (`<strike>`, `<font>`). */
const BASE_TAGS = new Set(['xliff:g', 'b', 'i', 'u']);

const tagNamesIn = (value: string): Set<string> =>
  new Set([...value.matchAll(/<\/?([a-zA-Z][\w:-]*)/g)].map((match) => (match[1] ?? '').toLowerCase()));

/**
 * Only markup the source already carries may reach the file as real tags; anything else that opens
 * with `<` is text the translator wrote, and text has to be escaped or the file is not XML.
 */
const escapeStrayMarkup = (value: string, allowed: Set<string>): string =>
  value.replace(/<(\/?)([a-zA-Z][\w:-]*)?/g, (match, _slash: string, name: string | undefined) =>
    name && allowed.has(name.toLowerCase()) ? match : `&lt;${match.slice(1)}`,
  );

const CDATA = /(<!\[CDATA\[[\s\S]*?\]\]>)/;

const normalizeText = (value: string, allowed: Set<string>): string =>
  escapeStrayMarkup(
    value
      .replace(/<br\s*\/?>/gi, '\\n')
      .replace(/[\u00A0\u202F\u2007]/g, ' ')
      .replace(/[\u2060\u0000\u200B\u200C\u200D\uFEFF]/g, '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;'),
    allowed,
  );

/** CDATA sections travel verbatim; everything between them is normalized and escaped. */
const normalizeXmlValue = (value: string, allowed: Set<string>): string =>
  value
    .split(CDATA)
    .map((segment) => (CDATA.test(segment) ? segment : normalizeText(segment, allowed)))
    .join('');

const isComposeResource = (filePath: string): boolean => filePath.includes('/composeResources/');

const keepQuotes = (value: string): string => (value.startsWith('"') && value.endsWith('"') ? value : `"${value}"`);

/**
 * Compose Multiplatform reads values via `textContent` and neither unwraps aapt-style quoting nor
 * decodes `\'`; classic `res/` needs both.
 */
const sanitizeXmlValue = (value: string, source: string, filePath: string): string => {
  const allowed = new Set([...BASE_TAGS, ...tagNamesIn(source)]);
  return isComposeResource(filePath)
    ? normalizeXmlValue(value, allowed)
    : normalizeXmlValue(keepQuotes(value), allowed).replace(/(?<!\\)'/g, "\\'");
};

/** `values-xx` or `values-xx-rYY`, unless the project maps the locale explicitly. */
const localeFolder = (locale: string, localeMap: Record<string, string> = {}): string => {
  const mapped = toFileLocale(locale, localeMap);
  if (mapped !== locale) return mapped.startsWith('values-') ? mapped : `values-${mapped}`;
  const [language, region] = locale.split('-');
  return region ? `values-${language}-r${region.toUpperCase()}` : `values-${language}`;
};

const attrString = (attrs: Record<string, string | undefined>): string =>
  Object.entries(attrs)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join('');

/**
 * Android `values/strings.xml` (+ `plurals.xml`). Mirrors the old import: `translatable="false"`
 * disables the key, single-element resources parse fine, quotes are unwrapped by a processor before
 * the model sees them, and plural categories the source language lacks are seeded from `other`.
 */
export const androidXml = (options: AndroidXmlOptions): Adapter => {
  const fileOptions: FileAdapterOptions = { include: ['**/values/strings.xml', '**/values/plurals.xml'], ...options };

  return {
    name: 'android-xml',

    async pull({ project }) {
      const resources: PulledResource[] = [];
      const extraQuantities = synthesizedQuantities(project);

      for (const filePath of await discoverFiles(fileOptions)) {
        const parsed = parseAndroidResources(await readText(options.root, filePath));
        const localeFiles = new Map<string, ParsedResource[]>();
        for (const locale of project.targetLocales) {
          const localePath = join(dirname(dirname(filePath)), localeFolder(locale, options.localeMap), basename(filePath));
          const xml = await readTextIfExists(options.root, localePath);
          if (xml !== null) localeFiles.set(locale, parseAndroidResources(xml));
        }
        const existing = (locale: string, predicate: (resource: ParsedResource) => string | undefined): string | undefined =>
          localeFiles
            .get(locale)
            ?.map(predicate)
            .find((value) => value?.trim());
        const targetsFor = (predicate: (resource: ParsedResource) => string | undefined): Record<string, string> =>
          Object.fromEntries(
            project.targetLocales.map((locale) => [locale, existing(locale, predicate)]).filter(([, v]) => v),
          ) as Record<string, string>;

        for (const resource of parsed) {
          const translatable = resource.attrs.translatable !== 'false';
          const formatted = resource.attrs.formatted;
          const base = { filePath, key: resource.name, formatted };

          if (resource.kind === 'string') {
            resources.push({
              key: compositeKey(base),
              source: resource.value,
              tags: ['android', 'string'],
              meta: { ...base },
              translatable,
              targets: targetsFor((r) => (r.kind === 'string' && r.name === resource.name ? r.value : undefined)),
            });
          } else if (resource.kind === 'plurals') {
            const other = resource.items.find((item) => item.quantity === 'other');
            const items = [
              ...resource.items,
              ...extraQuantities
                .filter((quantity) => other && !resource.items.some((item) => item.quantity === quantity))
                .map((quantity) => ({ quantity, value: other?.value ?? '', synthesized: true })),
            ];
            for (const item of items) {
              const tags = ['android', 'plural', ...('synthesized' in item ? ['synthesized'] : [])];
              resources.push({
                key: compositeKey({ ...base, quantity: item.quantity }),
                source: item.value,
                tags,
                meta: { ...base, quantity: item.quantity },
                translatable,
                targets: targetsFor((r) =>
                  r.kind === 'plurals' && r.name === resource.name
                    ? r.items.find((i) => i.quantity === item.quantity)?.value
                    : undefined,
                ),
              });
            }
          } else {
            resource.items.forEach((value, index) => {
              resources.push({
                key: compositeKey({ ...base, index }),
                source: value,
                tags: ['android', 'string-array'],
                meta: { ...base, index },
                translatable,
                targets: targetsFor((r) => (r.kind === 'string-array' && r.name === resource.name ? r.items[index] : undefined)),
              });
            });
          }
        }
      }
      return { resources };
    },

    async push({ project }, resources: PushResource[]) {
      const byFile = new Map<string, PushResource[]>();
      for (const resource of resources) {
        if (!resource.translatable) continue;
        const filePath = parseCompositeKey(resource.key)?.filePath;
        if (typeof filePath !== 'string') continue;
        byFile.set(filePath, [...(byFile.get(filePath) ?? []), resource]);
      }

      let written = 0;
      const files: string[] = [];
      for (const [filePath, fileResources] of byFile) {
        for (const locale of project.targetLocales) {
          const categories = pluralCategories(locale);
          type Entry = { value: string; source: string };
          const strings = new Map<string, Entry & { formatted?: string }>();
          const plurals = new Map<string, { formatted?: string; items: Map<string, Entry> }>();
          const arrays = new Map<string, { formatted?: string; items: Map<number, Entry> }>();

          for (const resource of fileResources) {
            const value = resource.targets[locale]?.value;
            const parsed = parseCompositeKey(resource.key);
            const key = parsed?.key;
            if (!value?.trim() || typeof key !== 'string') continue;
            const formatted = typeof parsed?.formatted === 'string' ? parsed.formatted : undefined;
            const item: Entry = { value, source: resource.source };
            if (typeof parsed?.quantity === 'string') {
              if (!categories.has(parsed.quantity)) continue;
              const entry = plurals.get(key) ?? { formatted, items: new Map<string, Entry>() };
              entry.items.set(parsed.quantity, item);
              plurals.set(key, entry);
            } else if (typeof parsed?.index === 'number') {
              const entry = arrays.get(key) ?? { formatted, items: new Map<number, Entry>() };
              entry.items.set(parsed.index, item);
              arrays.set(key, entry);
            } else {
              strings.set(key, { ...item, formatted });
            }
          }

          const sanitize = (entry: Entry) => sanitizeXmlValue(entry.value, entry.source, filePath);
          const lines: string[] = [];
          for (const [name, entry] of [...arrays].sort(byCodePoint)) {
            lines.push(`  <string-array name="${name}"${attrString({ formatted: entry.formatted })}>`);
            for (const [, item] of [...entry.items].sort(([a], [b]) => a - b)) lines.push(`    <item>${sanitize(item)}</item>`);
            lines.push('  </string-array>');
          }
          for (const [name, entry] of [...strings].sort(byCodePoint)) {
            lines.push(`  <string name="${name}"${attrString({ formatted: entry.formatted })}>${sanitize(entry)}</string>`);
          }
          for (const [name, entry] of [...plurals].sort(byCodePoint)) {
            lines.push(`  <plurals name="${name}"${attrString({ formatted: entry.formatted })}>`);
            for (const [quantity, item] of [...entry.items].sort(
              ([a], [b]) => PLURAL_ORDER.indexOf(a) - PLURAL_ORDER.indexOf(b),
            )) {
              lines.push(`    <item quantity="${quantity}">${sanitize(item)}</item>`);
            }
            lines.push('  </plurals>');
          }
          if (lines.length === 0) continue;

          const xml = [
            '<?xml version="1.0" encoding="utf-8"?>',
            '<resources xmlns:xliff="urn:oasis:names:tc:xliff:document:1.2">',
            ...lines,
            '</resources>',
            '',
          ].join('\n');
          const localePath = join(dirname(dirname(filePath)), localeFolder(locale, options.localeMap), basename(filePath));
          await writeText(options.root, localePath, xml);
          files.push(localePath);
          written += strings.size + plurals.size + arrays.size;
        }
      }
      return { written, files };
    },
  };
};
