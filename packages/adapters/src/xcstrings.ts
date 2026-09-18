import { type Adapter, isPlaceholderOnlyKey, type PulledResource, type PushResource } from '@opendeepl/sdk';
import { clean } from 'unllm';
import {
  compositeKey,
  discoverFiles,
  type FileAdapterOptions,
  parseCompositeKey,
  readText,
  toFileLocale,
  writeText,
} from './files';

type StringUnit = { stringUnit: { state?: string; value?: string } };
type PluralVariations = { variations: { plural: Record<string, StringUnit> } };
type Localization = StringUnit | PluralVariations;

type XcstringsEntry = {
  comment?: string;
  extractionState?: string;
  shouldTranslate?: boolean;
  localizations?: Record<string, Localization>;
};

type Xcstrings = { sourceLanguage: string; strings: Record<string, XcstringsEntry>; version?: string };

/** Normalize keys to prevent Unicode duplicates (smart quotes, special spaces, dashes). */
const normalizeKey = (key: string): string => clean(key, { invisible: true, spaces: true, quotes: true });

const isPlural = (localization: Localization | undefined): localization is PluralVariations =>
  localization !== undefined && 'variations' in localization;

const unitValue = (unit: StringUnit | undefined): string | undefined => unit?.stringUnit?.value;

const valueFor = (localization: Localization | undefined, quantity: string | undefined): string | undefined => {
  if (!localization) return undefined;
  if (isPlural(localization)) return quantity ? unitValue(localization.variations.plural[quantity]) : undefined;
  return quantity ? undefined : unitValue(localization);
};

// Apple's JSONSerialization.sortedKeys uses localizedStandardCompare: case-insensitive, numeric-aware.
const collator = new Intl.Collator('en', { numeric: true });

const sortKeysDeep = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(collator.compare)) {
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  }
  return sorted as T;
};

/** Xcode's own formatting: `"key" : value` with a space before the colon and expanded empty objects. */
export const formatXcstrings = (data: Xcstrings): string =>
  JSON.stringify(sortKeysDeep(data), null, 2)
    .replace(/^(\s*"(?:[^"\\]|\\.)*"): /gm, '$1 : ')
    .replace(/^(\s*"[^"]*" : )\{\}(,?)$/gm, (_, prefix: string, comma: string) => {
      const indent = prefix.match(/^\s*/)?.[0] ?? '';
      return `${prefix}{\n\n${indent}}${comma}`;
    });

export type XcstringsOptions = Omit<FileAdapterOptions, 'include'> & { include?: string[] };

/**
 * iOS/macOS `.xcstrings` catalogs. One resource per key (or per plural variant), keyed by
 * `compositeKey` so the same string gets the same key whichever adapter or tool derives it.
 */
export const xcstrings = (options: XcstringsOptions): Adapter => {
  const fileOptions: FileAdapterOptions = { include: ['**/*.xcstrings'], ...options };

  return {
    name: 'xcstrings',

    async pull({ project }) {
      const resources: PulledResource[] = [];
      const sourceFileLocale = toFileLocale(project.sourceLocale, options.localeMap);

      for (const filePath of await discoverFiles(fileOptions)) {
        let catalog: Xcstrings;
        try {
          catalog = JSON.parse(await readText(options.root, filePath)) as Xcstrings;
        } catch (error) {
          console.error(`[xcstrings] failed to parse ${filePath}`, error);
          continue;
        }
        const sourceLocale = catalog.sourceLanguage ?? sourceFileLocale;

        for (const [rawKey, entry] of Object.entries(catalog.strings ?? {})) {
          const key = normalizeKey(rawKey);
          if (isPlaceholderOnlyKey(key)) continue;
          const sourceLocalization = entry.localizations?.[sourceLocale];
          const quantities = isPlural(sourceLocalization)
            ? Object.keys(sourceLocalization.variations.plural)
            : [undefined];

          for (const quantity of quantities) {
            // An empty localization means "use the key as the value" in iOS.
            const source = valueFor(sourceLocalization, quantity) || key;
            if (!source.trim()) continue;

            const targets: Record<string, string> = {};
            for (const locale of project.targetLocales) {
              const existing = valueFor(entry.localizations?.[toFileLocale(locale, options.localeMap)], quantity);
              if (existing?.trim()) targets[locale] = existing;
            }

            resources.push({
              key: compositeKey({ filePath, key, quantity }),
              source,
              tags: ['ios', quantity ? 'plural' : 'string'],
              meta: { filePath, key, quantity, comment: entry.comment },
              translatable: entry.shouldTranslate !== false,
              targets,
            });
          }
        }
      }
      return { resources };
    },

    async push({ project }, resources: PushResource[]) {
      const byFile = new Map<string, PushResource[]>();
      for (const resource of resources) {
        const parsed = parseCompositeKey(resource.key);
        const filePath = typeof parsed?.filePath === 'string' ? parsed.filePath : null;
        if (!filePath) continue;
        byFile.set(filePath, [...(byFile.get(filePath) ?? []), resource]);
      }

      let written = 0;
      const files: string[] = [];
      for (const [filePath, fileResources] of byFile) {
        const catalog = JSON.parse(await readText(options.root, filePath)) as Xcstrings;
        let changed = false;

        for (const resource of fileResources) {
          const parsed = parseCompositeKey(resource.key);
          const key = typeof parsed?.key === 'string' ? parsed.key : null;
          const quantity = typeof parsed?.quantity === 'string' ? parsed.quantity : undefined;
          if (!key || !catalog.strings[key]) continue;
          const entry = catalog.strings[key];

          for (const [locale, target] of Object.entries(resource.targets)) {
            if (!project.targetLocales.includes(locale) || !target.value) continue;
            const fileLocale = toFileLocale(locale, options.localeMap);
            // Unchanged values are left alone, review state included: push only writes what differs.
            if (valueFor(entry.localizations?.[fileLocale], quantity) === target.value) continue;
            const unit: StringUnit = { stringUnit: { state: 'translated', value: target.value } };
            // Created only when something is written: an empty `localizations` is itself a diff.
            const localizations = (entry.localizations ??= {});
            if (quantity) {
              const current = localizations[fileLocale];
              const plural: PluralVariations = isPlural(current) ? current : { variations: { plural: {} } };
              plural.variations.plural[quantity] = unit;
              localizations[fileLocale] = plural;
            } else {
              localizations[fileLocale] = unit;
            }
            changed = true;
            written += 1;
          }
        }

        if (changed) {
          await writeText(options.root, filePath, formatXcstrings(catalog));
          files.push(filePath);
        }
      }
      return { written, files };
    },
  };
};
