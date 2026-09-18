import { z } from 'zod';
import { type Guard, guardKind } from './types';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const count = (value: string, term: string): number => value.match(new RegExp(escapeRegExp(term), 'g'))?.length ?? 0;

/**
 * A trademark must come back verbatim — same spelling, same script. Transliterations ("Акме" for "Acme")
 * and translations into a descriptive phrase both fail this: the term is simply absent. Counts are
 * compared as ≥ rather than =, since a language may legitimately mention the brand once where
 * English repeats it.
 */
export const brandTerms = (terms: string[]): Guard => ({
  name: 'brand-terms',
  match: () => terms.length > 0,
  check: (candidate, source) => {
    for (const term of terms) {
      const expected = count(source, term);
      if (expected === 0) continue;
      const actual = count(candidate, term);
      if (actual === 0) return `brand term "${term}" missing (source mentions it ${expected}x)`;
    }
    return null;
  },
  repair: (_candidate, _source, _ctx, reason) => ({
    prompt: `You fix a translation that mangled a brand name. ${reason}.
Rewrite each text so the brand names below appear EXACTLY as written, in Latin script, untranslated and untransliterated. Change nothing else.
Brand names: ${terms.map((term) => `"${term}"`).join(', ')}`,
  }),
});

export const brandTermsKind = guardKind({
  name: 'brand-terms',
  description: 'Brand names mentioned in the source must appear verbatim in the translation.',
  params: z.object({ terms: z.array(z.string().min(1)).min(1).describe('Brand names, exactly as they must appear') }),
  canRepair: true,
  create: ({ terms }) => brandTerms(terms),
});
