import { z } from 'zod';
import { type Guard, guardKind } from './types';

const metaMaxLength = (meta: Record<string, unknown>): number | null =>
  typeof meta.maxLength === 'number' && meta.maxLength > 0 ? meta.maxLength : null;

export type LengthCapParams = { maxLength?: number };

/** Three passes is where the returns stop: a model that has missed the same cut twice is not counting. */
const REPAIR_ATTEMPTS = 3;
/** Aim below the cap, not at it: the model cannot count characters, and a cut asked to the exact limit lands over it as often as under. */
const TARGET_RATIO = 0.95;

const shortenPrompt = (max: number, current: number): string => `You shorten translations that exceed a hard character limit.
The text is ${current} characters; it must be at most ${Math.floor(max * TARGET_RATIO)} characters (count every character, including spaces and punctuation).
Keep the language, meaning, tone, placeholders, HTML tags and brand names exactly as they are.
Strategy: shorter synonyms, drop filler words and articles, use common abbreviations, drop secondary information — brevity beats completeness.`;

/**
 * Hard character caps (store listings, ad headlines, UI labels). The translate prompt already asks
 * for a 5% margin; when a value still overflows, the repair layer gets a few passes at shortening
 * it before the target is rejected outright. An explicit `maxLength` (from a scenario rule) beats
 * the resource's own `meta.maxLength`.
 */
export const lengthCap = (params: LengthCapParams = {}): Guard => {
  const maxLengthOf = (meta: Record<string, unknown>): number | null => params.maxLength ?? metaMaxLength(meta);
  return {
    name: 'length-cap',
    match: (ctx) => maxLengthOf(ctx.meta) !== null,
    check: (candidate, _source, ctx) => {
      const max = maxLengthOf(ctx.meta);
      if (max === null || candidate.length <= max) return null;
      return `too long: ${candidate.length} chars, max ${max}`;
    },
    repair: (candidate, _source, ctx) => {
      const max = maxLengthOf(ctx.meta);
      return max === null ? null : { prompt: shortenPrompt(max, candidate.length) };
    },
    repairAttempts: REPAIR_ATTEMPTS,
  };
};

export const lengthCapKind = guardKind({
  name: 'length-cap',
  description: 'Rejects values longer than a character cap and asks a repair call to shorten them, up to three times.',
  params: z.object({ maxLength: z.number().int().positive().optional().describe('Hard cap in characters; empty means use the resource meta.maxLength') }),
  canRepair: true,
  create: (params) => lengthCap(params),
});
