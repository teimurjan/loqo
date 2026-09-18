import { SPECIFIER_TYPES } from '../guards/specifiers';
import { hasTag } from '../model/types';
import type { ValueProcessor } from './types';

// ---------------------------------------------------------------------------------------------
// Android quote unwrap (source stage)
// ---------------------------------------------------------------------------------------------

/** Android resources wrap values in quotes to keep leading/trailing whitespace; the model must not see them. */
export const androidUnwrapQuotes = (): ValueProcessor => ({
  name: 'android-unwrap-quotes',
  stage: 'source',
  match: (ctx) => hasTag(ctx, 'android'),
  process: (value) => (value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value),
});

// ---------------------------------------------------------------------------------------------
// Envelope leak (output stage)
// ---------------------------------------------------------------------------------------------

const ENVELOPE_TAIL = /["'“”‘’«»」』]?\s*[}\]]\s*$/;

const imbalance = (value: string, open: string, close: string): number =>
  value.split(open).length - value.split(close).length;

/**
 * How many more closers the value carries than the source — what separates an envelope tail from
 * a placeholder a translation legitimately moved to the end. `Create {chip} on` -> `فعِّل {chip}`
 * is balanced and must survive; `Get %@` -> `Get %@”}` has an orphan.
 */
const closerSurplus = (source: string, value: string): number =>
  Math.max(
    imbalance(source, '{', '}') - imbalance(value, '{', '}'),
    imbalance(source, '[', ']') - imbalance(value, '[', ']'),
  );

export const stripEnvelopeTail = (value: string, source = ''): string => {
  if (!ENVELOPE_TAIL.test(value)) return value;
  let result = value;
  for (let remaining = closerSurplus(source, value); remaining > 0; remaining -= 1) {
    const peeled = result.replace(ENVELOPE_TAIL, '');
    if (peeled === result) break;
    result = peeled;
  }
  return result;
};

/**
 * The prompt embeds the payload as ```` ```json{"id":"Get %@"}``` ````, putting the envelope's `"}`
 * flush against a specifier the model is told to copy verbatim. It copies the delimiters too.
 */
export const envelopeLeak = (): ValueProcessor => ({
  name: 'envelope-leak',
  stage: 'output',
  match: () => true,
  process: (value, source) => stripEnvelopeTail(value, source),
});

// ---------------------------------------------------------------------------------------------
// Transposed format specifiers (output stage)
// ---------------------------------------------------------------------------------------------

/**
 * iOS and Android share the printf positional convention `%<argnum>$<type>`. LLM output
 * occasionally transposes it to `%<argnum><type>$`, which breaks the mobile build. Only positional
 * forms with a trailing `$` are touched, so correct and non-positional specifiers are left alone.
 */
const TRANSPOSED_SPECIFIER = new RegExp(`%(\\d+)(${SPECIFIER_TYPES})\\$`, 'g');

export const repairFormatSpecifiers = (value: string): string =>
  value.replace(TRANSPOSED_SPECIFIER, (_match, argnum: string, type: string) => `%${argnum}$${type}`);

export const formatSpecifier = (): ValueProcessor => ({
  name: 'format-specifier',
  stage: 'output',
  match: (ctx) => hasTag(ctx, 'ios', 'android'),
  process: repairFormatSpecifiers,
});

// ---------------------------------------------------------------------------------------------
// HTML space entities (output stage)
// ---------------------------------------------------------------------------------------------

/**
 * French typography wants a non-breaking space before `? ! :`, so the model reaches for one and
 * encodes it as `&nbsp;`, which then reaches the page verbatim in plain-text fields. Each entity
 * becomes the space it names, so the typography survives; ordinary spaces around it go.
 */
const SPACE_ENTITY =
  /[ \t]*&(nbsp|ensp|emsp|thinsp|#0*160|#[xX]0*a0|#0*8194|#0*8195|#0*8201|#[xX]0*2009|#0*8239|#[xX]0*202f);[ \t]*/gi;

const SPACE_OF: Record<string, string> = {
  nbsp: '\u00A0',
  '#160': '\u00A0',
  '#xa0': '\u00A0',
  ensp: '\u2002',
  '#8194': '\u2002',
  emsp: '\u2003',
  '#8195': '\u2003',
  thinsp: '\u2009',
  '#8201': '\u2009',
  '#x2009': '\u2009',
  '#8239': '\u202F',
  '#x202f': '\u202F',
};

const spaceOf = (entity: string): string => SPACE_OF[entity.toLowerCase().replace(/^#(x?)0+(?=\w)/, '#$1')] ?? '\u00A0';

export const decodeSpaceEntities = (value: string): string => value.replace(SPACE_ENTITY, (_, entity: string) => spaceOf(entity));

export const spaceEntity = (): ValueProcessor => ({
  name: 'space-entity',
  stage: 'output',
  match: () => true,
  process: decodeSpaceEntities,
});
