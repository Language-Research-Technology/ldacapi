import type { AuthorisedEntity, EntityTransformer } from 'arocapi';
import type { FastifyRequest } from 'fastify';
import type { AccessControl } from './access/access-control.ts';
import { accessControlOf } from './entity-meta.ts';
import type { PrismaClient } from './generated/prisma/client.ts';
import { prisma } from './prisma.ts';

type Counts = { collections: number; objects: number; subCollections: number; files: number };

/** Oni's aggregates of an entity: what is below it, and the values at or below it */
type Aggregates = { counts: Counts; language: string[]; communicationMode: string[]; mediaType: string[] };

type OniEntity = AuthorisedEntity & Aggregates & { accessControl?: AccessControl };

const none = (): Aggregates => ({ counts: { collections: 0, objects: 0, subCollections: 0, files: 0 }, language: [], communicationMode: [], mediaType: [] });

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort();

/** The aggregates of each of `ids`, summing what each crate adds, in one query */
export async function aggregatesOf(db: Pick<PrismaClient, 'aggregate'>, ids: string[]) {
  const found = new Map<string, Aggregates>();
  for (const row of await db.aggregate.findMany({ where: { entityId: { in: ids } } })) {
    const sum = found.get(row.entityId) ?? none();
    found.set(row.entityId, {
      counts: {
        collections: sum.counts.collections + row.collections,
        objects: sum.counts.objects + row.objects,
        subCollections: sum.counts.subCollections + row.subCollections,
        files: sum.counts.files + row.files,
      },
      language: union(sum.language, row.language),
      communicationMode: union(sum.communicationMode, row.communicationMode),
      mediaType: union(sum.mediaType, row.mediaType),
    });
  }
  return found;
}

const batches = new WeakMap<FastifyRequest, Map<string, PromiseWithResolvers<Aggregates>>>();

/** Aggregates for every entity a request transforms, in one query: arocapi transforms a page's entities in the same tick */
const aggregatesFor = (request: FastifyRequest, id: string) => {
  let batch = batches.get(request);
  if (!batch) {
    const current = new Map<string, PromiseWithResolvers<Aggregates>>();
    batch = current;
    batches.set(request, current);
    queueMicrotask(() => {
      batches.delete(request);
      aggregatesOf(prisma, [...current.keys()]).then(
        (found) => {
          for (const [id, { resolve }] of current) {
            resolve(found.get(id) ?? none());
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
  let aggregates = batch.get(id);
  if (!aggregates) {
    aggregates = Promise.withResolvers<Aggregates>();
    batch.set(id, aggregates);
  }
  return aggregates.promise;
};

/** The fields Oni expects on every entity beyond the spec's: https://github.com/crate-works/oni/blob/main/docs/api-extensions.md */
export const oniEntityTransformer: EntityTransformer<AuthorisedEntity, OniEntity> = async (entity, { request }, { meta }) => {
  const accessControl = accessControlOf(meta);
  return { ...entity, ...(accessControl && { accessControl }), ...(await aggregatesFor(request, entity.id)) };
};
