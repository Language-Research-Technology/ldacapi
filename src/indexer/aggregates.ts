import type { PrismaClient } from '../generated/prisma/client.ts';
import type { Derivation } from './derive.ts';
import type { Progress } from './progress.ts';

/** Rows per transaction */
const BATCH_SIZE = 1000;

/** Writes what a crate adds to Oni's aggregates */
export class AggregatesWriter {
  prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async write({ crateId, aggregates }: Derivation, progress: Progress) {
    progress.start('aggregates', aggregates.length);
    for (let i = 0; i < aggregates.length; i += BATCH_SIZE) {
      const batch = aggregates.slice(i, i + BATCH_SIZE);
      await this.prisma.aggregate.createMany({ data: batch.map((aggregate) => ({ ...aggregate, crateId })) });
      progress.advance(batch.length);
    }
  }

  async delete(crateId: string) {
    await this.prisma.aggregate.deleteMany({ where: { crateId } });
  }
}
