import type { ResolvedConfig } from '../../config';
import type { GuardRule } from '../../db/schema';
import { matchesScope, type ResolutionScope, SCOPE_RANK } from '../layers/resolve';
import type { Guard } from './types';

/** For each guard name, the most specific matching rule; less specific ones are shadowed. */
const winningRules = (rules: GuardRule[], scope: ResolutionScope): Map<string, GuardRule> => {
  const winners = new Map<string, GuardRule>();
  const applicable = rules.filter((rule) => matchesScope(rule.scope, rule.scopeRef, scope)).sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]);
  for (const rule of applicable) winners.set(rule.guard, rule);
  return winners;
};

/**
 * The guards that run for one target: the always-on set from `translate.config.ts`, minus any
 * guard a matching rule switched off, plus rule instances built from their parameters. A rule is
 * an explicit assignment, so its instance skips the tag-based `match` and always runs.
 */
export const resolveGuards = (config: ResolvedConfig, rules: GuardRule[], scope: ResolutionScope): Guard[] => {
  const winners = winningRules(rules, scope);
  const defaults = config.guards.filter((guard) => !winners.has(guard.name));
  const assigned: Guard[] = [];
  for (const rule of winners.values()) {
    if (!rule.enabled) continue;
    const kind = config.guardKinds.find((candidate) => candidate.name === rule.guard);
    if (!kind) {
      console.warn(`[guards] rule for unknown guard kind "${rule.guard}" ignored`);
      continue;
    }
    const params = kind.params.safeParse(rule.params);
    if (!params.success) {
      console.warn(`[guards] rule ${rule.id} for "${rule.guard}" has invalid params and was ignored`);
      continue;
    }
    assigned.push({ ...kind.create(params.data), match: () => true });
  }
  return [...defaults, ...assigned];
};
