import { brandTerms, brandTermsKind } from './brand-terms';
import { lengthCap, lengthCapKind } from './length-cap';
import { newlineParity, newlineParityKind } from './newline-parity';
import { placeholderParity, placeholderParityKind } from './placeholder-parity';
import { pluralParity, pluralParityKind } from './plural-parity';
import type { Guard, GuardKind } from './types';

export { brandTerms, lengthCap, newlineParity, placeholderParity, pluralParity };
export type { Guard, GuardKind, RepairInstruction } from './types';

/** The built-in guards, in the order they run. Brand terms are a deployment's own, so they are not here. */
export const defaultGuards = (): Guard[] => [placeholderParity(), pluralParity(), newlineParity(), lengthCap()];

/** Everything a scenario may attach from the flow UI. */
export const defaultGuardKinds = (): GuardKind[] => [placeholderParityKind, pluralParityKind, newlineParityKind, lengthCapKind, brandTermsKind] as GuardKind[];
