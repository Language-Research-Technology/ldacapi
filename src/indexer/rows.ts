import type { Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { logger } from '../logger.ts';
import { fileStorageMeta } from '../repository/file-storage-meta.ts';
import type { Derivation, DerivedEntity } from './derive.ts';

const log = logger.child({ module: 'indexer/rows' });

/** Rows per transaction */
const BATCH_SIZE = 1000;

const batches = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / BATCH_SIZE) }, (_, i) => items.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE));

/** The entity rows indexed from `crateId` */
const rowsOf = (crateId: string): Prisma.EntityWhereInput => ({ meta: { path: ['crateId'], equals: crateId } });

/** The crate's root id is the id of the OCFL object holding it */
function fileRow(crateId: string, { file }: DerivedEntity): Prisma.FileCreateManyInput | undefined {
  if (!file) {
    return;
  }
  const { path, ...row } = file;
  return { ...row, meta: fileStorageMeta(crateId, path) };
}

/** Writes a crate's Entity and File rows */
export class RowsWriter {
  prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /** The ids of the rows written: an entity another crate already has a row for keeps that row */
  async write(derivation: Derivation) {
    const written = new Set<string>();
    for (const batch of batches(derivation.entities)) {
      const fileRows = batch.map((entity) => fileRow(derivation.crateId, entity));
      try {
        await this.writeBatch(batch, fileRows, written);
      } catch {
        // Row by row, to skip only the entity that can't be written
        for (const [i, entity] of batch.entries()) {
          await this.writeBatch([entity], [fileRows[i]], written).catch((error) =>
            log.error({ err: error, crateId: derivation.crateId, entityId: entity.row.id }, 'Error indexing entity'),
          );
        }
      }
    }
    return written;
  }

  private writeBatch(batch: DerivedEntity[], fileRows: (Prisma.FileCreateManyInput | undefined)[], written: Set<string>) {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.entity.createManyAndReturn({
        data: batch.map(({ row }) => ({ ...row, meta: row.meta as Prisma.InputJsonValue })),
        skipDuplicates: true,
        select: { id: true },
      });
      const ids = new Set(created.map(({ id }) => id));
      await tx.file.createMany({ data: fileRows.filter((row) => row && ids.has(row.id)) as Prisma.FileCreateManyInput[] });
      for (const id of ids) {
        written.add(id);
      }
    });
  }

  async delete(crateId: string) {
    await this.prisma.file.deleteMany({ where: { entity: rowsOf(crateId) } });
    await this.prisma.entity.deleteMany({ where: rowsOf(crateId) });
  }
}

/** The id of each entity row indexed from `crateId` */
export const crateRowIds = async (prisma: PrismaClient, crateId: string) =>
  (await prisma.entity.findMany({ where: rowsOf(crateId), select: { id: true } })).map(({ id }) => id);

/** How many entity and file rows were indexed from `crateId` */
export const countRows = async (prisma: PrismaClient, crateId: string) => ({
  entities: await prisma.entity.count({ where: rowsOf(crateId) }),
  files: await prisma.file.count({ where: { entity: rowsOf(crateId) } }),
});
