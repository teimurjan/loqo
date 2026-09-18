import { pluralCategories } from '../model/locales';
import { hasTag } from '../model/types';
import { type IcuArgument, scanIcuArguments } from './icu';
import { describeMultiset, isSameMultiset, type Multiset } from './specifiers';
import { z } from 'zod';
import { type Guard, guardKind } from './types';

const argumentMultiset = (args: IcuArgument[]): Multiset => {
  const counts: Multiset = new Map();
  for (const arg of args) {
    const label = arg.type ? `{${arg.name}, ${arg.type}}` : `{${arg.name}}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
};

const invalidCategory = (key: string, allowed: Set<string>): boolean => !key.startsWith('=') && !allowed.has(key);

/**
 * ICU messages: every `{argument}` the source declares must survive with the same type, and every
 * plural must be well-formed *for the target locale* — its variants drawn from the locale's own
 * categories (cardinal for `plural`, ordinal for `selectordinal`), none of them empty, and `other`
 * always present. Category sets legitimately differ from the source (English has no `few`), so
 * only the target side is validated against CLDR.
 */
export const pluralParity = (): Guard => ({
  name: 'plural-parity',
  match: (ctx) => hasTag(ctx, 'webapp', 'icu'),
  check: (candidate, source, ctx) => {
    const expected = scanIcuArguments(source);
    if (expected.length === 0) return null;
    const actual = scanIcuArguments(candidate);

    const expectedSet = argumentMultiset(expected);
    const actualSet = argumentMultiset(actual);
    if (!isSameMultiset(expectedSet, actualSet)) {
      return `ICU arguments changed: expected [${describeMultiset(expectedSet)}], got [${describeMultiset(actualSet)}]`;
    }

    for (const arg of actual) {
      if (arg.type !== 'plural' && arg.type !== 'selectordinal') continue;
      const allowed = pluralCategories(ctx.locale, arg.type === 'selectordinal' ? 'ordinal' : 'cardinal');
      const keys = Object.keys(arg.options);
      if (!keys.includes('other')) return `plural {${arg.name}} has no 'other' variant`;
      const bad = keys.filter((key) => invalidCategory(key, allowed));
      if (bad.length > 0) {
        return `plural {${arg.name}} uses categories invalid for ${ctx.locale}: ${bad.join(', ')} (allowed: ${[...allowed].join(', ')})`;
      }
      const empty = keys.filter((key) => arg.options[key]?.trim() === '');
      if (empty.length > 0) return `plural {${arg.name}} has empty variants: ${empty.join(', ')}`;
    }
    return null;
  },
});

export const pluralParityKind = guardKind({
  name: 'plural-parity',
  description: 'ICU plural arguments must keep their categories for the target locale, with a non-empty `other`.',
  params: z.object({}),
  canRepair: false,
  create: () => pluralParity(),
});
