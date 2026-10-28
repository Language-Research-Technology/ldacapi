import type { FastifyBaseLogger } from 'fastify';
import { hasState, type Repository, type RepositoryObject, State } from '../repository.ts';
import { isWithin } from './crates.ts';

/** What an action asked for and whether it was accepted, shown once on the next page */
export type Flash = { accepted: boolean; message: string };

const refused = (asked: string, reason: string): Flash => ({ accepted: false, message: `${asked} was refused: ${reason}.` });

/** The crates an action on `crateId` covers, it and the crates under it, or every crate; undefined if `crateId` isn't a crate */
const covered = async (repository: Repository, crateId: string | undefined): Promise<RepositoryObject[] | undefined> => {
  const objects = await Array.fromAsync(repository.objects());
  if (crateId === undefined) {
    return objects;
  }
  return objects.some(({ id }) => id === crateId) ? objects.filter(({ id }) => isWithin(id, crateId)) : undefined;
};

/** Queues indexing `crateId` and the crates under it, or every crate; `force` rebuilds indexes that already exist */
export const indexCrates = async (repository: Repository, log: FastifyBaseLogger, crateId: string | undefined, force: boolean): Promise<Flash> => {
  const asked = `${force ? 'Reindexing' : 'Indexing'} ${crateId ?? 'every crate'}`;
  const crates = await covered(repository, crateId);
  if (!crates) {
    return refused(asked, 'it was not found');
  }
  if (crates.some(({ state }) => hasState(state, State.DELETING))) {
    return refused(asked, 'deleting is in progress');
  }
  if (crates.some(({ state }) => hasState(state, State.QUEUED, State.INDEXING))) {
    return refused(asked, 'indexing is already in progress');
  }
  if (!force && crates.some(({ id, state }) => id === crateId && hasState(state, State.INDEXED))) {
    return refused(asked, 'it is already indexed, so reindex it instead');
  }
  repository
    .createIndex(
      crates.map(({ id }) => id),
      undefined,
      force,
    )
    .catch((err) => log.error({ err, crateId }, 'Indexing failed'));
  return { accepted: true, message: `${asked} has been queued.` };
};

/** Starts deleting the indexes of `crateId` and the crates under it, or every index */
export const deleteIndexes = async (repository: Repository, log: FastifyBaseLogger, crateId: string | undefined): Promise<Flash> => {
  const crates = await covered(repository, crateId);
  const under = crates && crates.length > 1 ? ' and the crates under it' : '';
  const asked = `Deleting ${crateId ? `the indexes of ${crateId}${under}` : 'every index'}`;
  if (!crates) {
    return refused(asked, 'it was not found');
  }
  if (crates.some(({ state }) => hasState(state, State.QUEUED, State.INDEXING))) {
    return refused(asked, 'indexing is in progress');
  }
  const deleting = crateId === undefined ? [repository.deleteIndex()] : crates.map(({ id }) => repository.deleteIndex(id));
  Promise.all(deleting).catch((err) => log.error({ err, crateId }, 'Deleting indexes failed'));
  return { accepted: true, message: `${asked} has started.` };
};
