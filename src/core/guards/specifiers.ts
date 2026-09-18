export { isPlaceholderOnlyKey, SPECIFIER, SPECIFIER_TYPES, stripSpecifiers } from '@opendeepl/sdk';

/** `{{name}}` template keys; the base translate prompt forbids touching them. */
export const MUSTACHE = /\{\{\s*[\w.-]+\s*\}\}/g;

/** Android `<xliff:g ...>...</xliff:g>` wrappers, compared as whole tags. */
export const XLIFF = /<xliff:g\b[^>]*>[\s\S]*?<\/xliff:g>/g;

export type Multiset = Map<string, number>;

export const countMatches = (value: string, pattern: RegExp): Multiset => {
  const counts: Multiset = new Map();
  for (const [match] of value.matchAll(pattern)) {
    counts.set(match, (counts.get(match) ?? 0) + 1);
  }
  return counts;
};

export const describeMultiset = (counts: Multiset): string =>
  [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([item, count]) => (count > 1 ? `${item}x${count}` : item))
    .join(', ') || 'none';

export const isSameMultiset = (a: Multiset, b: Multiset): boolean =>
  a.size === b.size && [...a.entries()].every(([item, count]) => b.get(item) === count);
