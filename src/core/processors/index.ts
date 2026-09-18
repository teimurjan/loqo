import { newlineExtract, newlineRestore } from './newline-placeholder';
import { androidUnwrapQuotes, envelopeLeak, formatSpecifier, spaceEntity } from './repairs';
import type { ValueProcessor } from './types';

export { androidUnwrapQuotes, envelopeLeak, formatSpecifier, newlineExtract, newlineRestore, spaceEntity };
export type { ValueProcessor } from './types';

/**
 * Order matters on both sides. Source: newline extraction goes last so nothing above sees a value
 * already carrying tokens. Output: newline restore goes first so the repairs below see the value in
 * the shape their source comparisons expect.
 */
export const defaultProcessors = (): ValueProcessor[] => [
  androidUnwrapQuotes(),
  newlineExtract(),
  newlineRestore(),
  envelopeLeak(),
  formatSpecifier(),
  spaceEntity(),
];
