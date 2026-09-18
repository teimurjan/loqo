import { arrayContains, type SQL, sql } from 'drizzle-orm';
import { resources } from '../../db/schema';

/**
 * The part of a project a store syncs at a time: resources under a key prefix (one document) and/or
 * carrying every one of the tags (one collection, one product). Both narrow; neither alone is required.
 */
export type ResourceScope = { prefix?: string; tags?: string[] };

export const scopeConditions = (scope: ResourceScope): SQL[] => [
  ...(scope.prefix ? [sql`starts_with(${resources.key}, ${scope.prefix})`] : []),
  ...(scope.tags && scope.tags.length > 0 ? [arrayContains(resources.tags, scope.tags)] : []),
];
