export { isPlaceholderOnlyKey, SPECIFIER, SPECIFIER_TYPES, stripSpecifiers } from '@loqo/sdk';

/** `{{name}}` template keys; the base translate prompt forbids touching them. */
export const MUSTACHE = /\{\{\s*[\w.-]+\s*\}\}/g;

/** Android `<xliff:g ...>...</xliff:g>` wrappers, attributes captured. */
export const XLIFF = /<xliff:g\b([^>]*)>[\s\S]*?<\/xliff:g>/g;

export type Multiset = Map<string, number>;

const increment = (counts: Multiset, item: string): void => {
  counts.set(item, (counts.get(item) ?? 0) + 1);
};

export const countMatches = (value: string, pattern: RegExp): Multiset => {
  const counts: Multiset = new Map();
  for (const [match] of value.matchAll(pattern)) increment(counts, match);
  return counts;
};

/**
 * Wrappers counted by `id`. aapt drops the tag itself at build time and the specifier check guards
 * what it wraps, so `example` and any text beside the specifier (`%1$s/year`) may be localized.
 * A wrapper without an `id` is counted whole.
 */
export const countXliffWrappers = (value: string): Multiset => {
  const counts: Multiset = new Map();
  for (const [tag, attrs] of value.matchAll(XLIFF)) {
    const id = attrs?.match(/\bid="([^"]*)"/)?.[1];
    increment(counts, id === undefined ? tag : `<xliff:g id="${id}">`);
  }
  return counts;
};

/** One occurrence fewer of `item`; unchanged when there is none. */
export const dropOne = (counts: Multiset, item: string): Multiset => {
  const count = counts.get(item);
  if (count === undefined) return counts;
  const next = new Map(counts);
  if (count === 1) next.delete(item);
  else next.set(item, count - 1);
  return next;
};

export const describeMultiset = (counts: Multiset): string =>
  [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([item, count]) => (count > 1 ? `${item}x${count}` : item))
    .join(', ') || 'none';

export const isSameMultiset = (a: Multiset, b: Multiset): boolean =>
  a.size === b.size && [...a.entries()].every(([item, count]) => b.get(item) === count);
