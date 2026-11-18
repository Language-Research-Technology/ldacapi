import type { Prisma, PrismaClient } from '../src/generated/prisma/client.ts';

/** How many statements in this database wait on a lock another transaction holds */
export const lockWaits = async (prisma: PrismaClient) =>
  (
    await prisma.$queryRaw<unknown[]>`
      SELECT 1 FROM pg_locks lock JOIN pg_stat_activity activity ON activity.pid = lock.pid
      WHERE NOT lock.granted AND activity.datname = current_database()`
  ).length;

/** Runs `body` in a transaction and resolves once it has, keeping the transaction, and its locks, open until `commit` */
export const holdTransaction = async (prisma: PrismaClient, body: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
  const { promise: held, resolve: hold } = Promise.withResolvers<void>();
  const { promise: committed, resolve: commit } = Promise.withResolvers<void>();
  const holding = prisma.$transaction(
    async (tx) => {
      await body(tx);
      hold();
      await committed;
    },
    { timeout: 60_000 },
  );
  await Promise.race([held, holding]);
  return {
    commit: async () => {
      commit();
      await holding;
    },
  };
};
