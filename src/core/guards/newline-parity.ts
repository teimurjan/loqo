import { hasTag } from '../model/types';
import { z } from 'zod';
import { type Guard, guardKind } from './types';

export const NEWLINE_TAG = 'preserve-newlines';

const lineBreaks = (value: string): number => value.split('\n').length - 1;

/**
 * Mobile screen copy and store release notes carry meaningful line breaks. The newline processors
 * ferry them through the model as `<br/>` tokens; this checks that exactly as many came back.
 */
export const newlineParity = (): Guard => ({
  name: 'newline-parity',
  match: (ctx) => hasTag(ctx, NEWLINE_TAG),
  check: (candidate, source) => {
    const expected = lineBreaks(source);
    const actual = lineBreaks(candidate);
    if (expected === actual) return null;
    return `line breaks changed: expected ${expected}, got ${actual}`;
  },
});

export const newlineParityKind = guardKind({
  name: 'newline-parity',
  description: 'The translation must contain exactly as many line breaks as the source.',
  params: z.object({}),
  canRepair: false,
  create: () => newlineParity(),
});
