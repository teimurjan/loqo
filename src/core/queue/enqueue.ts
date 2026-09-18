import { inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { targets } from '../../db/schema';
import type { EnqueueOptions, TranslateQueue } from './types';

const CHUNK = 500;

/** Queues one job per target and marks it `queued`, in chunks so a project-wide sync is not one giant statement. */
export const enqueueTargets = async (queue: TranslateQueue, db: Db, targetIds: string[], options: EnqueueOptions): Promise<number> => {
  if (targetIds.length === 0) return 0;
  for (let index = 0; index < targetIds.length; index += CHUNK) {
    const chunk = targetIds.slice(index, index + CHUNK);
    await queue.enqueue(
      chunk.map((targetId) => ({ targetId, force: options.force })),
      options,
    );
    await db.update(targets).set({ status: 'queued', updatedAt: new Date() }).where(inArray(targets.id, chunk));
  }
  return targetIds.length;
};
