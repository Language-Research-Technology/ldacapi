import type { AuthorisedEntity, EntityTransformer } from 'arocapi';
import type { FastifyRequest } from 'fastify';
import type { AccessControl } from './access/access-control.ts';
import { accessControlOf } from './entity-meta.ts';
import type { PrismaClient } from './generated/prisma/client.ts';

type Counts = { collections: number; objects: number; subCollections: number; files: number };

/** Oni's aggregates of an entity: what is below it, and the values at or below it */
type Aggregates = { counts: Counts; language: string[]; communicationMode: string[]; mediaType: string[] };

type OniEntity = AuthorisedEntity & Aggregates & { accessControl?: AccessControl };

const none = (): Aggregates => ({ counts: { collections: 0, objects: 0, subCollections: 0, files: 0 }, language: [], communicationMode: [], mediaType: [] });

type AggregateRow = Counts & Omit<Aggregates, 'counts'> & { entityId: string };

/** The aggregates of each of `ids`, summing what each crate adds, in one query */
export async function aggregatesOf(db: Pick<PrismaClient, '$queryRaw'>, ids: string[]) {
  const rows = await db.$queryRaw<AggregateRow[]>`
    SELECT "entityId",
      sum(collections)::int AS collections, sum(objects)::int AS objects, sum("subCollections")::int AS "subCollections", sum(files)::int AS files,
      ARRAY(SELECT DISTINCT v COLLATE "C" FROM aggregate other, unnest(other.language) v WHERE other."entityId" = aggregate."entityId" ORDER BY 1) AS language,
      ARRAY(SELECT DISTINCT v COLLATE "C" FROM aggregate other, unnest(other."communicationMode") v WHERE other."entityId" = aggregate."entityId" ORDER BY 1) AS "communicationMode",
      ARRAY(SELECT DISTINCT v COLLATE "C" FROM aggregate other, unnest(other."mediaType") v WHERE other."entityId" = aggregate."entityId" ORDER BY 1) AS "mediaType"
    FROM aggregate WHERE "entityId" = ANY(${ids}) GROUP BY "entityId"`;
  return new Map<string, Aggregates>(
    rows.map(({ entityId, collections, objects, subCollections, files, ...values }) => [
      entityId,
      { counts: { collections, objects, subCollections, files }, ...values },
    ]),
  );
}

const batches = new WeakMap<FastifyRequest, Map<string, PromiseWithResolvers<Aggregates>>>();

/** Aggregates for every entity a request transforms, in one query: arocapi transforms a page's entities in the same tick */
const aggregatesFor = (db: Pick<PrismaClient, '$queryRaw'>, request: FastifyRequest, id: string) => {
  const batch = batches.get(request) ?? new Map<string, PromiseWithResolvers<Aggregates>>();
  if (!batches.has(request)) {
    batches.set(request, batch);
    queueMicrotask(() => {
      batches.delete(request);
      aggregatesOf(db, [...batch.keys()]).then(
        (found) => {
          for (const [id, { resolve }] of batch) {
            resolve(found.get(id) ?? none());
          }
        },
        (error: unknown) => {
          for (const { reject } of batch.values()) {
            reject(error);
          }
        },
      );
    });
  }
  let aggregates = batch.get(id);
  if (!aggregates) {
    aggregates = Promise.withResolvers<Aggregates>();
    batch.set(id, aggregates);
  }
  return aggregates.promise;
};

/** The fields Oni expects on every entity beyond the spec's: https://github.com/crate-works/oni/blob/main/docs/api-extensions.md */
export const oniEntityTransformer =
  (db: Pick<PrismaClient, '$queryRaw'>): EntityTransformer<AuthorisedEntity, OniEntity> =>
  async (entity, { request }, { meta }) => {
    const accessControl = accessControlOf(meta);
    return { ...entity, ...(accessControl && { accessControl }), ...(await aggregatesFor(db, request, entity.id)) };
  };
