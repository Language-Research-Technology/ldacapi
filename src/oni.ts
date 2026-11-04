import type { AuthorisedEntity, EntityTransformer } from 'arocapi';
import type { FastifyRequest } from 'fastify';
import { type AccessControl, accessControlOf } from './entity-meta.ts';
import { prisma } from './prisma.ts';

export const COLLECTION = 'http://pcdm.org/models#Collection';
export const OBJECT = 'http://pcdm.org/models#Object';

type Counts = { collections: number; objects: number; subCollections: number; files: number };

type OniEntity = AuthorisedEntity & { counts: Counts; accessControl?: AccessControl };

const NONE: Counts = { collections: 0, objects: 0, subCollections: 0, files: 0 };

/** What is under each of `ids` by `memberOf`, which crosses into the crates of distributed collections */
const countsUnder = async (ids: string[]) => {
  const rows = await prisma.$queryRaw<(Counts & { anchor: string })[]>`
    WITH RECURSIVE under AS (
      SELECT "memberOf" AS anchor, id, "entityType", "memberOf" FROM entity WHERE "memberOf" = ANY(${ids})
      UNION
      SELECT u.anchor, e.id, e."entityType", e."memberOf" FROM entity e JOIN under u ON e."memberOf" = u.id
    )
    SELECT
      anchor,
      (count(*) FILTER (WHERE u."entityType" = ${COLLECTION}))::int AS collections,
      (count(*) FILTER (WHERE u."entityType" = ${OBJECT}))::int AS objects,
      (count(*) FILTER (WHERE u."entityType" = ${COLLECTION} AND u."memberOf" = u.anchor))::int AS "subCollections",
      count(f.id)::int AS files
    FROM under u LEFT JOIN file f ON f.id = u.id
    GROUP BY anchor`;
  return new Map(rows.map(({ anchor, ...counts }) => [anchor, counts]));
};

const batches = new WeakMap<FastifyRequest, Map<string, PromiseWithResolvers<Counts>>>();

/** Counts for every entity a request transforms, in one query: arocapi transforms a page's entities in the same tick */
const countsOf = (request: FastifyRequest, id: string) => {
  let batch = batches.get(request);
  if (!batch) {
    const current = new Map<string, PromiseWithResolvers<Counts>>();
    batch = current;
    batches.set(request, current);
    queueMicrotask(() => {
      batches.delete(request);
      countsUnder([...current.keys()]).then(
        (counts) => {
          for (const [id, { resolve }] of current) {
            resolve(counts.get(id) ?? NONE);
          }
        },
        (error: unknown) => {
          for (const { reject } of current.values()) {
            reject(error);
          }
        },
      );
    });
  }
  let counts = batch.get(id);
  if (!counts) {
    counts = Promise.withResolvers<Counts>();
    batch.set(id, counts);
  }
  return counts.promise;
};

/** The fields Oni expects on every entity beyond the spec's: https://github.com/crate-works/oni/blob/main/docs/api-extensions.md */
export const oniEntityTransformer: EntityTransformer<AuthorisedEntity, OniEntity> = async (entity, { request }, { meta }) => {
  const accessControl = accessControlOf(meta);
  return { ...entity, ...(accessControl && { accessControl }), counts: await countsOf(request, entity.id) };
};
