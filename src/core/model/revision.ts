import { createHash } from 'node:crypto';

/** Deterministic: re-importing unchanged content never re-translates. */
export const sourceRevisionOf = (source: string, comment: unknown): string =>
  createHash('sha256')
    .update(source)
    .update('\0')
    .update(typeof comment === 'string' ? comment : '')
    .digest('hex');
