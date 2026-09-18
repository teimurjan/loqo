export type PluralType = 'cardinal' | 'ordinal';

const cache = new Map<string, Set<string>>();

/**
 * CLDR plural categories a locale uses (`one`, `few`, `many`, `other`, ...): cardinal by default,
 * ordinal for `selectordinal` messages — the two sets differ (German ordinals are all `other`,
 * Catalan has `one`, `two`, `few`). `other` alone when the locale is unknown.
 */
export const pluralCategories = (locale: string, type: PluralType = 'cardinal'): Set<string> => {
  const key = `${type}:${locale}`;
  const cached = cache.get(key);
  if (cached) return cached;
  let categories: Set<string>;
  try {
    categories = new Set(new Intl.PluralRules(locale, { type }).resolvedOptions().pluralCategories);
  } catch {
    categories = new Set(['other']);
  }
  cache.set(key, categories);
  return categories;
};
