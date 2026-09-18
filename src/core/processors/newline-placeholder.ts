import { NEWLINE_TAG } from '../guards/newline-parity';
import { hasTag } from '../model/types';
import type { ValueProcessor } from './types';

/**
 * A line break only survives the LLM round trip if it looks like markup. Sent as a bare `\n`
 * inside the prompt's JSON payload it is routinely dropped or flattened to a space; an HTML tag is
 * covered by the rule the translate prompt already carries — preserve every tag exactly.
 */
export const NEWLINE_TOKEN = '<br/>';

/** Tolerates the spellings the model normalises to (`<br>`, `<br />`, `<BR/>`). */
const NEWLINE_TOKEN_PATTERN = /<br\s*\/?>/gi;

export const extractNewlines = (value: string): string => value.replace(/\n/g, NEWLINE_TOKEN);
export const restoreNewlines = (value: string): string => value.replace(NEWLINE_TOKEN_PATTERN, '\n');

export const newlineExtract = (): ValueProcessor => ({
  name: 'newline-extract',
  stage: 'source',
  match: (ctx) => hasTag(ctx, NEWLINE_TAG),
  process: extractNewlines,
});

export const newlineRestore = (): ValueProcessor => ({
  name: 'newline-restore',
  stage: 'output',
  match: (ctx) => hasTag(ctx, NEWLINE_TAG),
  process: restoreNewlines,
});
