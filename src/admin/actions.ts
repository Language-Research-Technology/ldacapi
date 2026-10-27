import type { FastifyBaseLogger } from 'fastify';
import { type Repository, State } from '../repository.ts';

/** What an action asked for and whether it was accepted, shown once on the next page */
export type Flash = { accepted: boolean; message: string };

const anyIn = (state: Record<string, string | undefined>, value: string) => Object.values(state).includes(value);

/** Queues indexing `crateId` and the crates under it, or every crate; `force` rebuilds indexes that already exist */
export const indexCrates = async (repository: Repository, log: FastifyBaseLogger, crateId: string | undefined, force: boolean): Promise<Flash> => {
  const asked = `${force ? 'Reindexing' : 'Indexing'} ${crateId ?? 'every crate'}`;
  const states = crateId ? [await repository.getState(crateId)] : (await Array.fromAsync(repository.objects())).map(({ state }) => state);
  if (states.some((state) => anyIn(state, State.DELETING))) {
    return { accepted: false, message: `${asked} was refused: deleting is in progress.` };
  }
  if (crateId && !force && states.some((state) => anyIn(state, State.INDEXED))) {
    return { accepted: false, message: `${asked} was refused: it is already indexed, so reindex it instead.` };
  }
  repository
    .createIndex(crateId ? new RegExp(`^${RegExp.escape(crateId)}`) : undefined, undefined, force)
    .catch((err) => log.error({ err, crateId }, 'Indexing failed'));
  return { accepted: true, message: `${asked} has been queued.` };
};

/** Starts deleting the indexes of `crateId`, or every index */
export const deleteIndexes = (repository: Repository, log: FastifyBaseLogger, crateId: string | undefined): Flash => {
  repository.deleteIndex(crateId).catch((err) => log.error({ err, crateId }, 'Deleting indexes failed'));
  return { accepted: true, message: `Deleting ${crateId ? `the indexes of ${crateId}` : 'every index'} has started.` };
};
