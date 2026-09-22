import { hasTag, type ValueContext } from '../model/types';
import { MUSTACHE, type Multiset, SPECIFIER, countMatches, countXliffWrappers, describeMultiset, dropOne, isSameMultiset } from './specifiers';
import { z } from 'zod';
import { type Guard, guardKind } from './types';

type PlaceholderFamily = {
  label: string;
  count: (value: string) => Multiset;
  applies: (ctx: ValueContext) => boolean;
  /** Placeholders the candidate may carry once each beyond the source's own. */
  extras?: (expected: Multiset, ctx: ValueContext) => string[];
};

/**
 * A plural's variants share one format string — Android and iOS pass the same arguments to
 * whichever variant the count selects — so a variant may use a specifier its own source omits:
 * English `one` says "Delete page", Russian `one` covers 21, 31, … and needs "Удалить %lld
 * страницу". The variant's source cannot say so; the adapter records the union of its siblings'
 * specifiers in `meta.pluralSpecifiers`.
 * TODO: drop once a plural is one resource with its variants as the value — its source will then
 * carry every specifier itself.
 */
const siblingSpecifiers = (expected: Multiset, ctx: ValueContext): string[] => {
  if (!hasTag(ctx, 'plural') || !Array.isArray(ctx.meta.pluralSpecifiers)) return [];
  return ctx.meta.pluralSpecifiers.filter((specifier): specifier is string => typeof specifier === 'string' && !expected.has(specifier));
};

const FAMILIES: PlaceholderFamily[] = [
  { label: 'format specifiers', count: (value) => countMatches(value, SPECIFIER), applies: (ctx) => hasTag(ctx, 'ios', 'android'), extras: siblingSpecifiers },
  { label: 'xliff wrappers', count: countXliffWrappers, applies: (ctx) => hasTag(ctx, 'android') },
  { label: 'template keys', count: (value) => countMatches(value, MUSTACHE), applies: () => true },
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
      const expected = family.count(source);
      const actual = family.count(candidate);
      if (expected.size === 0 && actual.size === 0) continue;
      const tolerated = (family.extras?.(expected, ctx) ?? []).reduce(dropOne, actual);
      if (isSameMultiset(expected, tolerated)) continue;
      return `${family.label} changed: expected [${describeMultiset(expected)}], got [${describeMultiset(actual)}]`;
    }
    return null;
  },
});

export const placeholderParityKind = guardKind({
  name: 'placeholder-parity',
  description: 'Every format specifier, xliff wrapper and {{template}} key in the source must survive, exactly once per occurrence.',
  params: z.object({}),
  canRepair: false,
  create: () => placeholderParity(),
});
