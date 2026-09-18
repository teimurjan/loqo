import {
  deepEqual,
  type ExtractedField,
  getLocalized,
  isLocalizedMap,
  isPlainObject,
  type LocaleContext,
  localize,
  parsePath,
  type Path,
  pathKey,
  projectLocale,
  type PulledResource,
  type PulledTarget,
  type PushRejection,
  type PushResource,
  restore,
  setAt,
  type Translations,
} from '@opendeepl/sdk';
import { type FieldConfigMap, fieldConfigAt } from './fields';
import { type DocumentRef, documentPrefix, entityTag, resourceKey } from './keys';
import { extractRichTextRestorable, htmlToNode, isLexicalNode, type LexicalCodec, nodeToHtml, restoreFromSource } from './rich-text';
import { createLocalizableExtractor, type PayloadContext } from './rules';

/**
 * The pure core of the adapter: a document (as `locale: 'all'` returns it) to canonical resources,
 * and canonical targets back to the document one locale will be written as. Nothing here touches
 * Payload; the adapter feeds it documents and writes what it returns.
 */
export type DocumentOptions = {
  sourceLocale: string;
  targetLocales: readonly string[];
  fields: FieldConfigMap;
  codec: LexicalCodec;
  /** Keys never translated, at any depth (`revision`, say). Each locale keeps its own value there. */
  ignore?: readonly string[];
  /**
   * A localized checkbox that switches translation off: `true` for the source locale makes the
   * document untranslatable, `true` for a target locale pins that locale. `null` disables the mapping.
   */
  disableField?: string | null;
  /**
   * Rows Payload cannot match to stored ones on write, beyond those visibly without an id: the
   * local API mints an id for an id-less row on every read, so the adapter finds them by reading
   * twice (`rowsWithUnstableId`). A locale is not written into a document that has any.
   */
  unmatchableRows?: readonly Path[];
  /**
   * Tags and meta every resource of a document carries, read off the document itself. Tags are what
   * scenarios select on (`ios`, `email`, `plural`); meta is what prompts read (`{{meta.comment}}`).
   * A field's own meta (`path`, `kind`, `maxLength`) wins over what is returned here.
   */
  describe?: Describe;
};

export type Description = { tags?: readonly string[]; meta?: Record<string, unknown> };

export type Describe = (ref: DocumentRef, document: unknown) => Description | undefined;

const disabledFor = (document: unknown, field: string | null | undefined, locale: string): boolean => {
  if (!field) return false;
  const flags = isPlainObject(document) ? document[field] : undefined;
  return isLocalizedMap(flags, locale) ? flags[locale] === true : false;
};

const extractAll = (document: unknown, options: DocumentOptions): Promise<ExtractedField[]> =>
  createLocalizableExtractor({ codec: options.codec, ignore: options.ignore })(document, {
    sourceLocale: options.sourceLocale,
    locale: options.sourceLocale,
    document,
    fields: options.fields,
  });

/** The locale's current value for a field, in the form the platform stores (rich text as HTML). An empty string is no translation. */
const targetValue = async (document: unknown, path: Path, kind: string, ctx: LocaleContext, codec: LexicalCodec): Promise<string | undefined> => {
  const current = getLocalized(document, path, ctx);
  const value = kind === 'richText' ? await nodeToHtml(current, codec) : typeof current === 'string' ? current : undefined;
  return value !== undefined && value.trim().length > 0 ? value : undefined;
};

export const documentToResources = async (ref: DocumentRef, document: unknown, options: DocumentOptions): Promise<PulledResource[]> => {
  const { sourceLocale } = options;
  const fields = await extractAll(document, options);
  const translatable = !disabledFor(document, options.disableField, sourceLocale);
  const described = options.describe?.(ref, document);

  return Promise.all(
    fields.map(async (field) => {
      const targets: Record<string, PulledTarget> = {};
      for (const locale of options.targetLocales) {
        const value = await targetValue(document, field.path, field.kind, { sourceLocale, locale }, options.codec);
        const pinned = disabledFor(document, options.disableField, locale);
        if (value !== undefined || pinned) targets[locale] = { ...(value !== undefined ? { value } : {}), ...(pinned ? { pinned } : {}) };
      }
      return {
        key: resourceKey(ref, field.path),
        source: field.value,
        tags: [...new Set([entityTag(ref), field.kind, ...(described?.tags ?? [])])],
        meta: { ...described?.meta, path: pathKey(field.path), kind: field.kind, ...field.meta },
        translatable,
        targets,
      };
    }),
  );
};

export type LocaleWrite = {
  locale: string;
  /** The document as this locale will be written. */
  data: unknown;
  /** Nothing differs from what the store already holds; skip the write. */
  unchanged: boolean;
  /** Units written whole this time, by path key. */
  units: string[];
  rejected: PushRejection[];
};

type FillRule = (path: Path) => 'fill' | 'skip' | 'opaque';

const holdsLocalized = (value: unknown, sourceLocale: string): boolean => {
  if (isLocalizedMap(value, sourceLocale)) return true;
  if (Array.isArray(value)) return value.some((item) => holdsLocalized(item, sourceLocale));
  return isPlainObject(value) && Object.values(value).some((entry) => holdsLocalized(entry, sourceLocale));
};

/**
 * Rows of shared arrays and blocks that have no `id` but hold localized values. Payload matches
 * incoming rows to stored ones by id alone, so a write in one locale rewrites such a row's
 * localized values with that locale only — every other locale in the row is gone. Localized maps
 * are not entered: a localized array's rows are one locale's own.
 */
/** Rows whose id differs between two reads of the same document: minted on read, absent in storage. */
export const rowsWithUnstableId = (first: unknown, second: unknown, sourceLocale: string, path: Path = []): Path[] => {
  if (isLocalizedMap(first, sourceLocale)) return [];
  if (Array.isArray(first)) {
    return first.flatMap((row, index) => {
      const at = [...path, index];
      const other = Array.isArray(second) ? second[index] : undefined;
      if (isPlainObject(row) && isPlainObject(other) && row.id !== other.id && holdsLocalized(row, sourceLocale)) return [at];
      return rowsWithUnstableId(row, other, sourceLocale, at);
    });
  }
  if (!isPlainObject(first) || !isPlainObject(second)) return [];
  return Object.entries(first).flatMap(([key, value]) => rowsWithUnstableId(value, second[key], sourceLocale, [...path, key]));
};

export const rowsWithoutId = (document: unknown, sourceLocale: string, path: Path = []): Path[] => {
  if (isLocalizedMap(document, sourceLocale)) return [];
  if (Array.isArray(document)) {
    return document.flatMap((row, index) => {
      const at = [...path, index];
      if (isPlainObject(row) && row.id === undefined && holdsLocalized(row, sourceLocale)) return [at];
      return rowsWithoutId(row, sourceLocale, at);
    });
  }
  if (!isPlainObject(document)) return [];
  return Object.entries(document).flatMap(([key, value]) => rowsWithoutId(value, sourceLocale, [...path, key]));
};

/**
 * Required localized values the locale does not have take the source's: a logo, a relation, an
 * option. Payload validates the locale as a whole document, so a required image is required in
 * every locale, translated or not. Anything translatable is opaque here — a rich-text tree or a
 * list of rows is the locale's own and never lined up with the source's — so prose is never
 * filled, and ignored keys stay the locale's own. Other arrays are paired by index when they line up.
 */
const fillRequired = (data: unknown, source: unknown, path: Path, rule: FillRule): unknown => {
  if (rule(path) === 'opaque') return data;
  if (Array.isArray(data) && Array.isArray(source) && data.length === source.length) {
    return data.map((item, index) => fillRequired(item, source[index], [...path, index], rule));
  }
  if (!isPlainObject(data) || !isPlainObject(source)) return data;
  const filled: Record<string, unknown> = { ...data };
  for (const [key, value] of Object.entries(source)) {
    const at = [...path, key];
    filled[key] = filled[key] === undefined ? (rule(at) === 'fill' ? value : undefined) : fillRequired(filled[key], value, at, rule);
  }
  return filled;
};

const groupByUnit = (fields: ExtractedField[]): Map<string, { unit: Path; paths: string[] }> => {
  const units = new Map<string, { unit: Path; paths: string[] }>();
  for (const field of fields) {
    const unit = field.unit ?? field.path;
    const entry = units.get(pathKey(unit)) ?? { unit, paths: [] };
    entry.paths.push(pathKey(field.path));
    units.set(pathKey(unit), entry);
  }
  return units;
};

/**
 * Targets for one document → what to write per locale. The base is the locale as stored, so
 * anything untranslated — flags, references, other locales' lists, fields still pending — stays
 * exactly as it is. A localized value is rewritten from the source's structure only when every
 * field extracted from it has a translation, so no locale ever holds a half-translated tree.
 * Required values the locale lacks and never translates come from the source. Resources of other
 * documents are ignored.
 */
export const localeWrites = async (ref: DocumentRef, document: unknown, resources: readonly PushResource[], options: DocumentOptions): Promise<LocaleWrite[]> => {
  const prefix = documentPrefix(ref);
  const own = resources.filter((resource) => resource.key.startsWith(prefix));
  const fields = await extractAll(document, options);
  const units = groupByUnit(fields);
  const translatable = [...units.values()].map(({ unit }) => pathKey(unit));
  const ignored = options.ignore ?? [];
  const fillRule: FillRule = (path) => {
    const key = pathKey(path);
    if (translatable.some((candidate) => candidate === key || key.startsWith(`${candidate}.`))) return 'opaque';
    if (path.some((segment) => typeof segment === 'string' && ignored.includes(segment))) return 'skip';
    return fieldConfigAt(options.fields, path, document)?.required === true ? 'fill' : 'skip';
  };
  const writes: LocaleWrite[] = [];
  const unmatchable = [...rowsWithoutId(document, options.sourceLocale), ...(options.unmatchableRows ?? [])];

  for (const locale of options.targetLocales) {
    const ctx: PayloadContext = { sourceLocale: options.sourceLocale, locale, document, fields: options.fields };
    const translations: Translations = {};
    const rejected: PushRejection[] = [];
    if (unmatchable.length > 0) {
      const reason = `not written: row ${pathKey(unmatchable[0] ?? [])} has no stored id, so Payload would drop its other locales on a write in ${locale}; give the document's rows ids first`;
      const affected = own.filter((resource) => resource.targets[locale]).map((resource) => ({ key: resource.key, locale, reason }));
      if (affected.length > 0) writes.push({ locale, data: projectLocale(document, ctx), unchanged: true, units: [], rejected: affected });
      continue;
    }
    for (const resource of own) {
      const target = resource.targets[locale];
      if (!target) continue;
      const path = typeof resource.meta.path === 'string' ? resource.meta.path : resource.key.slice(prefix.length);
      if (resource.meta.kind !== 'richText') {
        translations[path] = target.value;
        continue;
      }
      const node = await htmlToNode(target.value, typeof resource.meta.subType === 'string' ? resource.meta.subType : undefined, options.codec);
      if (!node) {
        rejected.push({ key: resource.key, locale, reason: 'HTML did not convert to a Lexical node' });
        continue;
      }
      const sourceBlock = getLocalized(document, parsePath(path), { sourceLocale: options.sourceLocale, locale: options.sourceLocale });
      translations[path] = isLexicalNode(sourceBlock) ? restoreFromSource(node, sourceBlock) : node;
    }
    if (Object.keys(translations).length === 0 && rejected.length === 0) continue;

    const stored = projectLocale(document, ctx);
    let data = stored;
    const written: string[] = [];
    for (const [key, { unit, paths }] of units) {
      if (!paths.every((path) => Object.hasOwn(translations, path))) continue;
      const source = getLocalized(document, unit, { sourceLocale: options.sourceLocale, locale: options.sourceLocale });
      data = setAt(data, unit, localize(source, translations, ctx, unit));
      // The HTML round trip drops upload nodes; the source tree has them.
      if (isPlainObject(source) && isLexicalNode(source.root)) data = restore(data, extractRichTextRestorable(source.root, [...unit, 'root']));
      written.push(key);
    }
    data = fillRequired(data, projectLocale(document, { sourceLocale: options.sourceLocale, locale: options.sourceLocale }), [], fillRule);
    writes.push({ locale, data, unchanged: deepEqual(data, stored), units: written, rejected });
  }
  return writes;
};
