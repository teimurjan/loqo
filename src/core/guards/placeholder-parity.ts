import { hasTag, type ValueContext } from '../model/types';
import { MUSTACHE, SPECIFIER, XLIFF, countMatches, describeMultiset, isSameMultiset } from './specifiers';
import { z } from 'zod';
import { type Guard, guardKind } from './types';

type PlaceholderFamily = { label: string; pattern: RegExp; applies: (ctx: ValueContext) => boolean };

const FAMILIES: PlaceholderFamily[] = [
  { label: 'format specifiers', pattern: SPECIFIER, applies: (ctx) => hasTag(ctx, 'ios', 'android') },
  { label: 'xliff tags', pattern: XLIFF, applies: (ctx) => hasTag(ctx, 'android') },
  { label: 'template keys', pattern: MUSTACHE, applies: () => true },
];

/**
 * Rejects a translation that lost or invented a placeholder. Argument order legitimately changes
 * between languages, but the set cannot: every placeholder the source declares has to survive,
 * exactly once per occurrence. A missing `%1$s` ships a string with no count in it; an extra one
 * crashes the formatter. Runs after the output processors, so transposed specifiers are already
 * repaired by the time this looks.
 */
export const placeholderParity = (): Guard => ({
  name: 'placeholder-parity',
  match: (ctx) => FAMILIES.some((family) => family.applies(ctx)),
  check: (candidate, source, ctx) => {
    for (const family of FAMILIES) {
      if (!family.applies(ctx)) continue;
      const expected = countMatches(source, family.pattern);
      const actual = countMatches(candidate, family.pattern);
      if (expected.size === 0 && actual.size === 0) continue;
      if (isSameMultiset(expected, actual)) continue;
      return `${family.label} changed: expected [${describeMultiset(expected)}], got [${describeMultiset(actual)}]`;
    }
    return null;
  },
});

export const placeholderParityKind = guardKind({
  name: 'placeholder-parity',
  description: 'Every format specifier, xliff tag and {{template}} key in the source must survive, exactly once per occurrence.',
  params: z.object({}),
  canRepair: false,
  create: () => placeholderParity(),
});
