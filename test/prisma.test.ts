import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../src/configuration.ts';
import type { PrismaClient } from '../src/generated/prisma/client.ts';
import { prisma } from '../src/prisma.ts';
import { prismaFor } from './scratch-indexes.ts';

type Explained = [{ 'QUERY PLAN': [{ Plan: unknown; JIT?: unknown }] }];

/** The plan of a query Postgres estimates as costly enough to JIT-compile */
const planOfCostlyQuery = async (db: PrismaClient) => {
  const [, explained] = await db.$transaction([
    db.$executeRaw`SET LOCAL jit_above_cost = 0`,
    db.$queryRaw<Explained>`EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*) FROM entity`,
  ]);
  return explained[0]['QUERY PLAN'][0];
};

const plain = prismaFor(new URL(config.databaseUrl));

afterAll(async () => {
  await Promise.all([prisma.$disconnect(), plain.$disconnect()]);
});

describe('the database client', () => {
  it('never JIT-compiles a query, however costly Postgres estimates it', async () => {
    expect(await planOfCostlyQuery(plain)).toHaveProperty('JIT');

    const plan = await planOfCostlyQuery(prisma);

    expect(plan).toHaveProperty('Plan');
    expect(plan).not.toHaveProperty('JIT');
  });
});
