import { getAt, isPlainObject, type Path, pathKey, setAt } from './object';

/**
 * The "localized map" convention: a store that returns every locale at once represents a localized
 * field as `{ [locale]: value }`. Payload's `locale: 'all'` does; so do plenty of i18n JSON layouts.
 */
export type LocaleContext = { sourceLocale: string; locale: string };

export const isLocalizedMap = (value: unknown, sourceLocale: string): value is Record<string, unknown> =>
  isPlainObject(value) && Object.hasOwn(value, sourceLocale);

/** Reads `path` as one locale sees it: every localized map on the way collapses to that locale's value. */
export const getLocalized = (document: unknown, path: Path, ctx: LocaleContext): unknown => {
  let current = document;
  for (const segment of path) {
    if (isLocalizedMap(current, ctx.sourceLocale)) current = current[ctx.locale];
    current = getAt(current, [segment]);
  }
  return isLocalizedMap(current, ctx.sourceLocale) ? current[ctx.locale] : current;
};

export type Translations = Record<string, unknown>;

/**
 * A localized value as `locale` will be written: the source value is the base — so the locale gets
 * the source's structure, be it a list or a rich-text tree — and `translations` (by path key)
 * replace the leaves at their paths. Nested localized maps collapse to the source value too. What
 * the round trip loses (rich-text link fields, say) is put back afterwards with `restore`.
 */
export const localize = (document: unknown, translations: Translations, ctx: LocaleContext, path: Path = []): unknown => {
  const key = pathKey(path);
  if (path.length > 0 && Object.hasOwn(translations, key)) return translations[key];
  if (Array.isArray(document)) return document.map((item, index) => localize(item, translations, ctx, [...path, index]));
  if (isLocalizedMap(document, ctx.sourceLocale)) return localize(document[ctx.sourceLocale], translations, ctx, path);
  if (isPlainObject(document)) {
    return Object.fromEntries(Object.entries(document).map(([field, value]) => [field, localize(value, translations, ctx, [...path, field])]));
  }
  return document;
};

/** The document as `locale` currently is: every localized map collapses to that locale's own value. */
export const projectLocale = (document: unknown, ctx: LocaleContext): unknown => {
  if (Array.isArray(document)) return document.map((item) => projectLocale(item, ctx));
  if (isLocalizedMap(document, ctx.sourceLocale)) return projectLocale(document[ctx.locale], ctx);
  if (isPlainObject(document)) {
    return Object.fromEntries(Object.entries(document).map(([field, value]) => [field, projectLocale(value, ctx)]));
  }
  return document;
};

export type RestorableField = { path: Path; value: unknown };

/** Puts locale-owned values back over a `localize`d document. */
export const restore = (document: unknown, fields: readonly RestorableField[]): unknown =>
  fields.reduce((current, field) => setAt(current, field.path, field.value), document);
