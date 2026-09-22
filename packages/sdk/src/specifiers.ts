/** The printf types iOS and Android emit, longest-first so `lld` beats `ld` and `llu` beats `lu`. */
export const SPECIFIER_TYPES = '@|lld|llu|ld|lu|lf|zu|d|u|f|s|c';

/** `%%` first so a literal percent wins over a misparse. */
export const SPECIFIER = new RegExp(`%%|%(?:(\\d+)\\$)?(${SPECIFIER_TYPES})`, 'g');

export const stripSpecifiers = (value: string): string => value.replace(SPECIFIER, '');

/**
 * Every specifier any variant of a plural carries. Android and iOS pass the same arguments to
 * whichever variant the count selects, so a variant may use a specifier its own source omits
 * (English `one` says "Delete page"; Russian `one` covers 21, 31, … and needs the number).
 * `undefined` when there are none, so it drops out of a resource's meta.
 */
export const pluralSpecifiers = (variants: string[]): string[] | undefined => {
  const found = [...new Set(variants.flatMap((variant) => variant.match(SPECIFIER) ?? []))];
  return found.length > 0 ? found : undefined;
};

/**
 * Nothing to translate once specifiers are removed, so the model fills the gap with hallucinations
 * or fragments of its own JSON envelope. Digits count as translatable: `1.5×` becomes `1,5×` in de.
 */
export const isPlaceholderOnlyKey = (key: string): boolean => !/[\p{L}\p{N}]/u.test(stripSpecifiers(key));
