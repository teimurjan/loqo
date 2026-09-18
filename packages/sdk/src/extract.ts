import { isPlainObject, type Path } from './object';
import { isLocalizedMap, type LocaleContext } from './localized';

/**
 * A document walker built from rules. Each rule either claims a value (returns fields, possibly
 * by recursing through `nest`) or passes (`undefined`) so the next rule can look. Order matters:
 * put the specific rules before `arrays()` and `objects()`.
 */
export type Nest<T> = (value: unknown, path: Path) => Promise<T[]>;

export type ExtractRule<T, C> = (value: unknown, path: Path, ctx: C, nest: Nest<T>) => T[] | undefined | Promise<T[] | undefined>;

export type ExtractorOptions = {
  /** Keys never descended into, at any depth (`revision`, `disableTranslate`, ...). */
  ignoreKeys?: readonly string[];
  onUnmatched?: (path: Path) => void;
};

export type Extractor<T, C> = (document: unknown, ctx: C) => Promise<T[]>;

export const createExtractor = <T, C>(rules: readonly ExtractRule<T, C>[], options: ExtractorOptions = {}): Extractor<T, C> => {
  const ignored = new Set(options.ignoreKeys ?? []);
  return (document, ctx) => {
    const visit: Nest<T> = async (value, path) => {
      const key = path[path.length - 1];
      if (typeof key === 'string' && ignored.has(key)) return [];
      for (const rule of rules) {
        const fields = await rule(value, path, ctx, visit);
        if (fields !== undefined) return fields;
      }
      options.onUnmatched?.(path);
      return [];
    };
    return visit(document, []);
  };
};

const flat = async <T>(results: Promise<T[]>[]): Promise<T[]> => (await Promise.all(results)).flat();

export const arrays =
  <T, C>(): ExtractRule<T, C> =>
  (value, path, _ctx, nest) =>
    Array.isArray(value) ? flat(value.map((item, index) => nest(item, [...path, index]))) : undefined;

export const objects =
  <T, C>(): ExtractRule<T, C> =>
  (value, path, _ctx, nest) =>
    isPlainObject(value) ? flat(Object.entries(value).map(([key, item]) => nest(item, [...path, key]))) : undefined;

/* ── Localizable fields ─────────────────────────────────────────────────────────────────────── */

export type ExtractedField = {
  path: Path;
  value: string;
  /** `text`, `richText`, ... — becomes a tag and `meta.kind`. */
  kind: string;
  meta?: Record<string, unknown>;
  /**
   * The localized value this field is part of — a rich-text tree, a breadcrumb list. A store writes
   * a unit whole, once every field in it is translated, so a locale never holds a half-translated
   * tree. Defaults to `path`.
   */
  unit?: Path;
};

export type LocalizedTextOptions<C> = {
  /** A localized string that is an id, not prose (uploads, relationships): claim it, emit nothing. */
  skip?: (path: Path, ctx: C) => boolean;
  meta?: (path: Path, ctx: C) => Record<string, unknown> | undefined;
};

/** `{ [locale]: string }` maps: the source value is the text to translate. Nothing to translate is not a field. */
export const localizedText =
  <C extends LocaleContext>(options: LocalizedTextOptions<C> = {}): ExtractRule<ExtractedField, C> =>
  (value, path, ctx) => {
    if (!isLocalizedMap(value, ctx.sourceLocale)) return undefined;
    const source = value[ctx.sourceLocale];
    if (typeof source !== 'string') return undefined;
    if (source.trim().length === 0 || options.skip?.(path, ctx)) return [];
    return [{ path, value: source, kind: 'text', meta: options.meta?.(path, ctx) }];
  };
