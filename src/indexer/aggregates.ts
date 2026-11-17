import type { PrismaClient } from '../generated/prisma/client.ts';
import type { Derivation } from './derive.ts';

/** Rows per transaction */
const BATCH_SIZE = 1000;

/** Writes what a crate adds to Oni's aggregates */
export class AggregatesWriter {
  prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async write({ crateId, aggregates }: Derivation) {
    for (let i = 0; i < aggregates.length; i += BATCH_SIZE) {
      await this.prisma.aggregate.createMany({ data: aggregates.slice(i, i + BATCH_SIZE).map((aggregate) => ({ ...aggregate, crateId })) });
    }
  }

  async delete(crateId: string) {
    await this.prisma.aggregate.deleteMany({ where: { crateId } });
  }
}
