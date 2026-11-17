import type { Prisma } from '../generated/prisma/client.ts';
import type { Document } from '../search-backend.ts';
import type { EntityRow } from './derive.ts';

/** A crate's derived copy of a shared entity, kept on its link */
export type Copy = { row: EntityRow; document: Document };

export type Contender = { crateId: string; openMetadata: boolean };

/** The copy a shared entity's row and document are: an open metadata licence first, then the lowest crate id */
export const winner = <T extends Contender>(links: T[]) => links.reduce<T | undefined>((best, link) => (!best || beats(link, best) ? link : best), undefined);

export const beats = (link: Contender, other: Contender) => (link.openMetadata === other.openMetadata ? link.crateId < other.crateId : link.openMetadata);

/** A transaction holding entities' locks may wait for another crate's */
export const TRANSACTION = { maxWait: 60_000, timeout: 60_000 };

/** Holds the entities `ids` until `tx` ends, so their links, rows and documents change one crate at a time */
export const lockEntities = (tx: Prisma.TransactionClient, ids: string[]) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(h) FROM (SELECT DISTINCT hashtext(id) AS h FROM unnest(${ids}::text[]) AS id ORDER BY h) locks`;

/** Each of `ids` grouped with its links */
export function linksById<T extends { entityId: string }>(ids: string[], links: T[]) {
  const byId = new Map<string, T[]>(ids.map((id) => [id, []]));
  for (const link of links) {
    (byId.get(link.entityId) as T[]).push(link);
  }
  return byId;
}

/** A collection, object or file another crate holds, or an id two crates describe as different kinds of entity */
export class ClashError extends Error {
  entityId: string;

  constructor(entityId: string, holder: string, crateId: string, kinds?: { held: string; described: string }) {
    super(
      kinds
        ? `${entityId} is a ${kinds.held} in crate ${holder} but a ${kinds.described} in crate ${crateId}`
        : `${entityId} is already held by crate ${holder}, so crate ${crateId} can't describe it too`,
    );
    this.name = 'ClashError';
    this.entityId = entityId;
  }
}
