import type { IndexQueue } from '../index-queue/index-queue.ts';

/** What an action asked for and whether it was accepted, shown once on the next page */
export type Flash = { accepted: boolean; message: string };

const queued = (asked: string): Flash => ({ accepted: true, message: `${asked} has been queued.` });

const refused = (asked: string, reason: string): Flash => ({ accepted: false, message: `${asked} was refused: ${reason}.` });

/** What an action covers: a crate, with `under` the crates under it too, or with no crate every crate */
export type Asked = { crateId: string | undefined; under: boolean };

const covering = ({ crateId, under }: Asked) => (crateId === undefined ? 'every crate' : `${crateId}${under ? ' and the crates under it' : ''}`);

/** Asks to index the crates asked for; `force` reindexes crates already indexed at their head version */
export const indexCrates = async (indexQueue: IndexQueue, scope: Asked, force: boolean): Promise<Flash> => {
  const { crateId, under } = scope;
  const asked = `${force ? 'Reindexing' : 'Indexing'} ${covering(scope)}`;
  if (crateId === undefined) {
    await indexQueue.indexEverything({ reindex: force });
  } else if (await indexQueue.crate(crateId)) {
    await (force ? indexQueue.reindex(crateId, { under }) : indexQueue.index(crateId, { under }));
  } else {
    return refused(asked, 'it was not found');
  }
  return queued(asked);
};

/** Asks to delete the indexes of the crates asked for, or with no crate every index */
export const deleteIndexes = async (indexQueue: IndexQueue, scope: Asked): Promise<Flash> => {
  const { crateId, under } = scope;
  if (crateId === undefined) {
    await indexQueue.deleteEverything();
    return queued('Deleting every index');
  }
  const asked = `Deleting the indexes of ${covering(scope)}`;
  if (!(await indexQueue.crate(crateId))) {
    return refused(asked, 'it was not found');
  }
  await indexQueue.delete(crateId, { under });
  return queued(asked);
};
