import type { IndexJobKind, Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { WORKER_SILENT_MILLISECONDS } from '../index-queue/index-queue.ts';
import { logger } from '../logger.ts';

const log = logger.child({ module: 'indexer' });

/** A job whose worker dies on this many attempts fails */
const MAXIMUM_ATTEMPTS = 3;

/** A job with no crate deletes everything */
export type Job = { id: number; crateId: string | null; kind: IndexJobKind; attempts: number };

/** Records a worker as alive, now */
export const heartbeat = async (prisma: PrismaClient, workerId: string) => {
  const heartbeatAt = new Date();
  await prisma.indexWorker.upsert({ where: { id: workerId }, create: { id: workerId, heartbeatAt }, update: { heartbeatAt } });
};

export const removeWorker = async (prisma: PrismaClient, workerId: string) => {
  await prisma.indexWorker.deleteMany({ where: { id: workerId } });
};

/** Returns the jobs of workers silent too long, or gone, to waiting (unless one waits already), and removes those workers */
async function returnDeadWorkersJobs(prisma: PrismaClient) {
  const silentSince = new Date(Date.now() - WORKER_SILENT_MILLISECONDS);
  await prisma.$transaction(async (tx) => {
    const orphans = await tx.$queryRaw<Job[]>`
      SELECT id, "crateId", kind, attempts FROM index_job job
      WHERE status = 'running' AND NOT EXISTS (SELECT 1 FROM index_worker worker WHERE worker.id = job."workerId" AND worker."heartbeatAt" > ${silentSince})
      FOR UPDATE SKIP LOCKED`;
    for (const job of orphans) {
      if (job.attempts >= MAXIMUM_ATTEMPTS) {
        await tx.indexJob.deleteMany({ where: { crateId: job.crateId, status: 'failed' } });
        const error = new Error(`Its worker died on each of ${job.attempts} attempts`);
        await tx.indexJob.update({ where: { id: job.id }, data: { status: 'failed', error: String(error), failedAt: new Date() } });
        log.error({ jobId: job.id, crateId: job.crateId, kind: job.kind, attempts: job.attempts }, 'Job failed: its worker died');
      } else if (await tx.indexJob.count({ where: { crateId: job.crateId, status: 'waiting' } })) {
        await tx.indexJob.delete({ where: { id: job.id } });
      } else {
        await tx.indexJob.update({ where: { id: job.id }, data: { status: 'waiting', workerId: null, startedAt: null } });
      }
    }
    await tx.indexWorker.deleteMany({ where: { heartbeatAt: { lte: silentSince } } });
  });
}

/**
 * Claims the oldest waiting job whose crate has none running, for `workerId`, first returning dead workers' jobs.
 * Deleting everything waits for every running job, and every job asked for after it waits for it.
 * The claim records `workerId` as alive with it, so its job is never taken for a dead worker's
 */
export async function claim(prisma: PrismaClient, workerId: string): Promise<Job | undefined> {
  await returnDeadWorkersJobs(prisma);
  const heartbeatAt = new Date();
  const [, [job]] = await prisma.$transaction([
    prisma.indexWorker.upsert({ where: { id: workerId }, create: { id: workerId, heartbeatAt }, update: { heartbeatAt } }),
    prisma.$queryRaw<Job[]>`
    UPDATE index_job SET status = 'running', "workerId" = ${workerId}, attempts = attempts + 1, "startedAt" = now()
    WHERE id = (
      SELECT id FROM index_job waiting
      WHERE status = 'waiting'
        AND NOT EXISTS (
          SELECT 1 FROM index_job running
          WHERE running.status = 'running' AND (running."crateId" = waiting."crateId" OR running."crateId" IS NULL OR waiting."crateId" IS NULL)
        )
        AND NOT EXISTS (SELECT 1 FROM index_job everything WHERE everything."crateId" IS NULL AND everything.status = 'waiting' AND everything.id < waiting.id)
      ORDER BY id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "crateId", kind, attempts`,
  ]);
  return job;
}

/** Returns a running job to waiting as if never tried, or drops it when another waits for its crate */
export const release = (prisma: PrismaClient, workerId: string, job: Job) =>
  prisma.$transaction([
    prisma.$executeRaw`
      DELETE FROM index_job WHERE id = ${job.id} AND "workerId" = ${workerId} AND status = 'running'
      AND EXISTS (SELECT 1 FROM index_job waiting WHERE waiting."crateId" IS NOT DISTINCT FROM ${job.crateId} AND waiting.status = 'waiting')`,
    prisma.indexJob.updateMany({
      where: { id: job.id, workerId, status: 'running' },
      data: { status: 'waiting', workerId: null, startedAt: null, attempts: { decrement: 1 } },
    }),
  ]);

/** What a finished job writes to its crate's record: new values, or its removal */
export type RecordWrite = { crateId: string } & ({ data: Prisma.CrateRecordUpdateInput } | { remove: true });

/** Whether `workerId` still holds the job's claim, locking its row for `tx` if so */
const holdsClaim = async (tx: Prisma.TransactionClient, workerId: string, job: Job) =>
  (await tx.$queryRaw<unknown[]>`SELECT 1 FROM index_job WHERE id = ${job.id} AND "workerId" = ${workerId} AND status = 'running' FOR UPDATE`).length > 0;

/**
 * Writes the crate's `record`, and removes the job and any earlier failure of its crate it makes stale.
 * Writes nothing and returns false if `workerId` no longer holds the claim
 */
export const succeed = (prisma: PrismaClient, workerId: string, job: Job, record?: RecordWrite) =>
  prisma.$transaction(async (tx) => {
    if (!(await holdsClaim(tx, workerId, job))) {
      return false;
    }
    if (record && 'remove' in record) {
      await tx.crateRecord.delete({ where: { id: record.crateId } });
    } else if (record) {
      await tx.crateRecord.update({ where: { id: record.crateId }, data: record.data });
    }
    await tx.indexJob.deleteMany({ where: { OR: [{ id: job.id }, { crateId: job.crateId, status: 'failed' }] } });
    return true;
  });

/**
 * Marks a job failed with `error`, replacing any earlier failure of its crate.
 * Writes nothing and returns false if `workerId` no longer holds the claim
 */
export const fail = (prisma: PrismaClient, workerId: string, job: Job, error: unknown) =>
  prisma.$transaction(async (tx) => {
    if (!(await holdsClaim(tx, workerId, job))) {
      return false;
    }
    await tx.indexJob.deleteMany({ where: { crateId: job.crateId, status: 'failed' } });
    await tx.indexJob.update({ where: { id: job.id }, data: { status: 'failed', error: String(error), failedAt: new Date() } });
    return true;
  });
