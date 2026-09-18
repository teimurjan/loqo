import type { ValueContext } from '../model/types';

/**
 * Source processors reshape a value before it reaches the model (unwrap quotes, tokenize line
 * breaks). Output processors repair what the model corrupted in ways code can fix. An output
 * processor that changes a value leaves a `repair` verdict on the target.
 */
export interface ValueProcessor {
  readonly name: string;
  readonly stage: 'source' | 'output';
  match(ctx: ValueContext): boolean;
  process(value: string, source: string, ctx: ValueContext): string;
}
