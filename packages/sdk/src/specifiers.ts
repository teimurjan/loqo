/** The printf types iOS and Android emit, longest-first so `lld` beats `ld` and `llu` beats `lu`. */
export const SPECIFIER_TYPES = '@|lld|llu|ld|lu|lf|zu|d|u|f|s|c';

/** `%%` first so a literal percent wins over a misparse. */
export const SPECIFIER = new RegExp(`%%|%(?:(\\d+)\\$)?(${SPECIFIER_TYPES})`, 'g');

export const stripSpecifiers = (value: string): string => value.replace(SPECIFIER, '');

/**
 * Nothing to translate once specifiers are removed, so the model fills the gap with hallucinations
 * or fragments of its own JSON envelope. Digits count as translatable: `1.5×` becomes `1,5×` in de.
 */
export const isPlaceholderOnlyKey = (key: string): boolean => !/[\p{L}\p{N}]/u.test(stripSpecifiers(key));
