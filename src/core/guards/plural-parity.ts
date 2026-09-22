import { hasTag } from '../model/types';
import { type IcuArgument, scanIcuArguments } from './icu';
import { z } from 'zod';
import { type Guard, guardKind } from './types';

const argumentNames = (args: IcuArgument[]): Set<string> => new Set(args.map((arg) => arg.name));

const describe = (names: Set<string>): string => [...names].sort().join(', ') || 'none';

const isSameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((name) => b.has(name));

/**
 * ICU messages: every argument the source declares must survive by name, and every plural must
 * carry an `other` variant. How an argument is used may change — `{count} pages` becomes
 * `{count, plural, …}` where grammar demands it — since the caller passes the same value either
 * way. Categories the locale lacks are never selected, so they are noise, not errors; an empty
 * variant is the suffix idiom the source itself uses (`file{n, plural, one {} other {s}}`).
 */
export const pluralParity = (): Guard => ({
  name: 'plural-parity',
  match: (ctx) => hasTag(ctx, 'webapp', 'icu'),
  check: (candidate, source) => {
    const expected = scanIcuArguments(source);
    if (expected.length === 0) return null;
    const actual = scanIcuArguments(candidate);

    const expectedNames = argumentNames(expected);
    const actualNames = argumentNames(actual);
    if (!isSameSet(expectedNames, actualNames)) {
      return `ICU arguments changed: expected [${describe(expectedNames)}], got [${describe(actualNames)}]`;
    }

    for (const arg of actual) {
      if (arg.type !== 'plural' && arg.type !== 'selectordinal') continue;
      if (!Object.keys(arg.options).includes('other')) return `plural {${arg.name}} has no 'other' variant`;
    }
    return null;
  },
});

export const pluralParityKind = guardKind({
  name: 'plural-parity',
  description: 'ICU arguments must survive by name and every plural must carry an `other` variant.',
  params: z.object({}),
  canRepair: false,
  create: () => pluralParity(),
});
