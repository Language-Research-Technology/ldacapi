import type { IndexQueue } from '../index-queue/index-queue.ts';

/** What an action asked for and whether it was accepted, shown once on the next page */
export type Flash = { accepted: boolean; message: string };

const queued = (asked: string): Flash => ({ accepted: true, message: `${asked} has been queued.` });

const refused = (asked: string, reason: string): Flash => ({ accepted: false, message: `${asked} was refused: ${reason}.` });

/** Asks to index `crateId`, or every crate; `force` reindexes crates already indexed at their head version */
export const indexCrates = async (indexQueue: IndexQueue, crateId: string | undefined, force: boolean): Promise<Flash> => {
  const asked = `${force ? 'Reindexing' : 'Indexing'} ${crateId ?? 'every crate'}`;
  if (crateId === undefined) {
    await indexQueue.indexEverything({ reindex: force });
  } else if (await indexQueue.crate(crateId)) {
    await (force ? indexQueue.reindex(crateId) : indexQueue.index(crateId));
  } else {
    return refused(asked, 'it was not found');
  }
  return queued(asked);
};

/** Asks to delete the indexes of `crateId` */
export const deleteIndexes = async (indexQueue: IndexQueue, crateId: string | undefined): Promise<Flash> => {
  if (crateId === undefined) {
    return refused('Deleting every index', 'choose a crate to delete the indexes of');
  }
  const asked = `Deleting the indexes of ${crateId}`;
  if (!(await indexQueue.crate(crateId))) {
    return refused(asked, 'it was not found');
  }
  await indexQueue.delete(crateId);
  return queued(asked);
};
