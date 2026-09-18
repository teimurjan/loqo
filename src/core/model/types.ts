/**
 * The canonical resource model is the SDK's contract (`@opendeepl/sdk`): what adapters send to
 * `/import` and read back from `/translations`. This module adds what only the pipeline needs.
 */
export type { PulledResource, PulledTarget, ResourceKey } from '@opendeepl/sdk';
export { pulledTarget } from '@opendeepl/sdk';

/** Plugin hooks may answer synchronously; the pipeline awaits either way. */
export type MaybePromise<T> = T | Promise<T>;

/** What guards and processors see about the value they are judging. */
export type ValueContext = {
  projectSlug: string;
  sourceLocale: string;
  locale: string;
  key: string;
  tags: string[];
  meta: Record<string, unknown>;
};

export const hasTag = (ctx: { tags: string[] }, ...tags: string[]): boolean =>
  tags.some((tag) => ctx.tags.includes(tag));
