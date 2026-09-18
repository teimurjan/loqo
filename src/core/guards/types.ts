import type { ZodType } from 'zod';
import type { MaybePromise, ValueContext } from '../model/types';

export type RepairInstruction = {
  /** System prompt for a repair call; the rejected value travels in the usual envelope. */
  prompt: string;
  /** `provider:model`; defaults to the last pipeline layer's model. */
  model?: string;
};

/**
 * Guards reject; they never rewrite. A value processor can repair a corruption it knows how to
 * rewrite (a transposed specifier, a leaked envelope), but a dropped `%1$s` cannot be put back by
 * code — the value has to go back to a model, or be thrown away. A check may await something —
 * a translation memory, a database, an external QA service; `match` stays synchronous because
 * the flow page asks it for every guard on every render.
 */
export interface Guard {
  readonly name: string;
  match(ctx: ValueContext): boolean;
  /** `null` when the candidate is acceptable, otherwise the reason it must be rejected. */
  check(candidate: string, source: string, ctx: ValueContext): MaybePromise<string | null>;
  /** How an LLM repair layer should fix a rejected value; omit when nothing but a retry helps. */
  repair?(candidate: string, source: string, ctx: ValueContext, reason: string): MaybePromise<RepairInstruction | null>;
  /** Repair calls this guard may spend on one value before it is rejected for good; 1 when omitted. */
  readonly repairAttempts?: number;
}

/**
 * What the flow UI can attach to a scenario: the implementation stays code, only the parameters
 * are data. `params` is exposed as JSON schema so the UI can render a form for it.
 */
export type GuardKind<Params = unknown> = {
  readonly name: string;
  readonly description: string;
  readonly params: ZodType<Params>;
  /** Whether instances offer a repair instruction; shown in the UI before any instance exists. */
  readonly canRepair: boolean;
  create(params: Params): Guard;
};

export const guardKind = <Params>(kind: GuardKind<Params>): GuardKind<Params> => kind;
