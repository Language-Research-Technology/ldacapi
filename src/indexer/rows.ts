import { Prisma, type PrismaClient } from '../generated/prisma/client.ts';
import { fileStorageMeta } from '../repository/file-storage-meta.ts';
import { chunks } from './chunks.ts';
import type { Derivation, DerivedEntity, EntityRow } from './derive.ts';
import { beats, ClashError, type Contender, type Copy, linksById, lockEntities, TRANSACTION, winner } from './links.ts';
import type { Progress } from './progress.ts';

/** Rows per transaction */
const BATCH_SIZE = 1000;

const entityData = (row: EntityRow) => ({ ...row, meta: row.meta as Prisma.InputJsonValue });

/** The crate's root id is the id of the OCFL object holding it */
function fileRow(crateId: string, { file }: DerivedEntity): Prisma.FileCreateManyInput | undefined {
  if (!file) {
    return;
  }
  const { path, ...row } = file;
  return { ...row, meta: fileStorageMeta(crateId, path) };
}

/** What deleting a crate's rows changed: entities left with no crate, and shared entities now another crate's copy */
export type RowsDeleted = { orphaned: string[]; rebuilt: string[] };

/** Writes a crate's crate links, and its Entity and File rows */
export class RowsWriter {
  prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /** Fails on a clash, naming the entity */
  async write(derivation: Derivation, progress: Progress) {
    progress.start('database index', derivation.entities.length);
    for (const batch of chunks(derivation.entities, BATCH_SIZE)) {
      try {
        await this.writeBatch(derivation, batch);
      } catch (error) {
        if (error instanceof ClashError) {
          progress.on = error.entityId;
          throw error;
        }
        // Row by row, so the failure names the entity that can't be written
        for (const entity of batch) {
          await progress.onItem(entity.row.id, () => this.writeBatch(derivation, [entity]));
        }
      }
      progress.advance(batch.length);
    }
  }

  private writeBatch({ crateId, openMetadata }: Derivation, batch: DerivedEntity[]) {
    const ids = batch.map(({ row }) => row.id);
    return this.prisma.$transaction(async (tx) => {
      await lockEntities(tx, ids);
      const rows = new Map((await tx.entity.findMany({ where: { id: { in: ids } }, select: { id: true, entityType: true } })).map((row) => [row.id, row]));
      const others = linksById(
        ids,
        await tx.crateLink.findMany({
          where: { entityId: { in: ids }, crateId: { not: crateId } },
          select: { entityId: true, crateId: true, openMetadata: true },
        }),
      );
      const ours = { crateId, openMetadata };
      const held: DerivedEntity[] = [];
      const created: EntityRow[] = [];
      const replaced: EntityRow[] = [];
      for (const entity of batch) {
        const { id, entityType } = entity.row;
        const holder = winner(others.get(id) as Contender[]);
        const row = rows.get(id);
        if (holder && row && row.entityType !== entityType) {
          throw new ClashError(id, holder.crateId, crateId, { held: row.entityType, described: entityType });
        }
        if (!entity.shared) {
          if (holder) {
            throw new ClashError(id, holder.crateId, crateId);
          }
          held.push(entity);
        } else if (!row) {
          created.push(entity.row);
        } else if (!holder || beats(ours, holder)) {
          replaced.push(entity.row);
        }
      }
      await tx.crateLink.createMany({
        data: batch.map(({ row, document, shared }) => ({
          crateId,
          entityId: row.id,
          openMetadata,
          copy: shared ? ({ row, document } satisfies Copy as Prisma.InputJsonValue) : Prisma.DbNull,
        })),
      });
      await tx.entity.createMany({ data: [...held.map(({ row }) => row), ...created].map(entityData) });
      await tx.file.createMany({ data: held.flatMap((entity) => fileRow(crateId, entity) ?? []) });
      for (const row of replaced) {
        await tx.entity.update({ where: { id: row.id }, data: entityData(row) });
      }
    }, TRANSACTION);
  }

  /** Removes the crate's links, then the rows left with none, and makes the rows of shared entities it won the next crate's copy */
  async delete(crateId: string): Promise<RowsDeleted> {
    const deleted: RowsDeleted = { orphaned: [], rebuilt: [] };
    for (const ids of chunks(await crateEntityIds(this.prisma, crateId), BATCH_SIZE)) {
      await this.prisma.$transaction(async (tx) => {
        await lockEntities(tx, ids);
        const links = linksById(
          ids,
          await tx.crateLink.findMany({ where: { entityId: { in: ids } }, select: { entityId: true, crateId: true, openMetadata: true } }),
        );
        const orphaned: string[] = [];
        const rebuilt: { entityId: string; crateId: string }[] = [];
        for (const [id, all] of links) {
          const others = all.filter((link) => link.crateId !== crateId);
          const next = winner(others);
          if (!next) {
            orphaned.push(id);
          } else if (winner(all)?.crateId === crateId) {
            rebuilt.push(next);
          }
        }
        await tx.crateLink.deleteMany({ where: { crateId, entityId: { in: ids } } });
        await tx.file.deleteMany({ where: { id: { in: orphaned } } });
        await tx.entity.deleteMany({ where: { id: { in: orphaned } } });
        const copies = rebuilt.length > 0 ? await tx.crateLink.findMany({ where: { OR: rebuilt }, select: { copy: true } }) : [];
        for (const { copy } of copies) {
          const { row } = copy as Copy;
          await tx.entity.update({ where: { id: row.id }, data: entityData(row) });
        }
        deleted.orphaned.push(...orphaned);
        deleted.rebuilt.push(...rebuilt.map(({ entityId }) => entityId));
      }, TRANSACTION);
    }
    return deleted;
  }
}

const crateEntityIds = async (prisma: PrismaClient, crateId: string) =>
  (await prisma.crateLink.findMany({ where: { crateId }, select: { entityId: true } })).map(({ entityId }) => entityId);
