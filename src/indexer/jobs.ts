import type { IndexJobKind, Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { WORKER_SILENT_MILLISECONDS } from '../index-queue/index-queue.ts';
import { logger } from '../logger.ts';
import type { Progress } from './progress.ts';

const log = logger.child({ module: 'indexer' });

/** A job whose worker dies on this many attempts fails */
const MAXIMUM_ATTEMPTS = 3;

/** A job with no crate deletes everything */
export type Job = { id: number; crateId: string | null; kind: IndexJobKind; attempts: number };

const touchWorker = (prisma: PrismaClient, workerId: string) => {
  const heartbeatAt = new Date();
  return prisma.indexWorker.upsert({ where: { id: workerId }, create: { id: workerId, heartbeatAt }, update: { heartbeatAt } });
};

/**
 * Records a worker as alive, now, with the progress of the job it is `running`: the only write of progress.
 * Returns false if the worker no longer holds that job's claim
 */
export async function heartbeat(prisma: PrismaClient, workerId: string, running?: { job: Job; progress: Progress }) {
  if (!running) {
    await touchWorker(prisma, workerId);
    return true;
  }
  const { job, progress } = running;
  const [, { count }] = await prisma.$transaction([
    touchWorker(prisma, workerId),
    prisma.indexJob.updateMany({
      where: { id: job.id, workerId, status: 'running' },
      data: { stage: progress.stage, done: progress.done, total: progress.total },
    }),
  ]);
  return count > 0;
}

export const removeWorker = async (prisma: PrismaClient, workerId: string) => {
  await prisma.indexWorker.deleteMany({ where: { id: workerId } });
};

/**
 * Returns running jobs to waiting in their place, or drops those whose crate has a job waiting; with `refund`, as if never tried.
 * Deleted and inserted again, as updating them to waiting fails on a job asked for meanwhile
 */
async function returnToWaiting(tx: Prisma.TransactionClient, ids: number[], { refund }: { refund: boolean }) {
  await tx.$executeRaw`
    WITH returned AS (DELETE FROM index_job WHERE id = ANY(${ids}) RETURNING id, "crateId", kind, attempts, "createdAt")
    INSERT INTO index_job (id, "crateId", kind, attempts, "createdAt")
    SELECT id, "crateId", kind, attempts - ${refund ? 1 : 0}::int, "createdAt" FROM returned
    ON CONFLICT DO NOTHING`;
}

/** Marks a job failed, replacing any earlier failure of its crate */
async function markFailed(tx: Prisma.TransactionClient, job: Job, failure: { error: string; stage?: string; failedOn?: string | null }) {
  await tx.indexJob.deleteMany({ where: { crateId: job.crateId, status: 'failed' } });
  await tx.indexJob.update({ where: { id: job.id }, data: { status: 'failed', failedAt: new Date(), done: null, total: null, ...failure } });
}

/** Returns the jobs of workers silent too long, or gone, to waiting (unless one waits already), and removes those workers */
export async function returnDeadWorkersJobs(prisma: PrismaClient) {
  const silentSince = new Date(Date.now() - WORKER_SILENT_MILLISECONDS);
  await prisma.$transaction(async (tx) => {
    const orphans = await tx.$queryRaw<Job[]>`
      SELECT id, "crateId", kind, attempts FROM index_job job
      WHERE status = 'running' AND NOT EXISTS (SELECT 1 FROM index_worker worker WHERE worker.id = job."workerId" AND worker."heartbeatAt" > ${silentSince})
      FOR UPDATE SKIP LOCKED`;
    const retried: number[] = [];
    for (const job of orphans) {
      if (job.attempts < MAXIMUM_ATTEMPTS) {
        retried.push(job.id);
        continue;
      }
      await markFailed(tx, job, { error: String(new Error(`Its worker died on each of ${job.attempts} attempts`)) });
      log.error({ jobId: job.id, crateId: job.crateId, kind: job.kind, attempts: job.attempts }, 'Job failed: its worker died');
    }
    await returnToWaiting(tx, retried, { refund: false });
    await tx.indexWorker.deleteMany({ where: { heartbeatAt: { lte: silentSince } } });
  });
}

/**
 * Claims the oldest waiting job whose crate has none running, for `workerId`.
 * Deleting everything waits for every running job, and every job asked for after it waits for it.
 * The claim records `workerId` as alive with it, so its job is never taken for a dead worker's.
 * Claims are made one at a time, so each sees the jobs the others claimed running
 */
export async function claim(prisma: PrismaClient, workerId: string): Promise<Job | undefined> {
  const [, , [job]] = await prisma.$transaction([
    prisma.$executeRaw`SELECT pg_advisory_xact_lock(1, 1)`,
    touchWorker(prisma, workerId),
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

/** Whether `workerId` still holds the job's claim, locking its row for `tx` if so */
const holdsClaim = async (tx: Prisma.TransactionClient, workerId: string, job: Job) =>
  (await tx.$queryRaw<unknown[]>`SELECT 1 FROM index_job WHERE id = ${job.id} AND "workerId" = ${workerId} AND status = 'running' FOR UPDATE`).length > 0;

/** Returns a running job to waiting as if never tried, or drops it when another waits for its crate */
export const release = (prisma: PrismaClient, workerId: string, job: Job) =>
  prisma.$transaction(async (tx) => {
    if (await holdsClaim(tx, workerId, job)) {
      await returnToWaiting(tx, [job.id], { refund: true });
    }
  });

/** Whether any of the crates `crateIds` has a job waiting or running */
export const unfinished = async (prisma: PrismaClient, crateIds: string[]) =>
  (await prisma.$queryRaw<unknown[]>`SELECT 1 FROM index_job WHERE "crateId" = ANY(${crateIds}) AND status IN ('waiting', 'running') LIMIT 1`).length > 0;

/** What a finished job writes to its crate's record: new values, or its removal */
export type RecordWrite = { crateId: string } & ({ data: Prisma.CrateRecordUpdateInput } | { remove: true });

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
      // Kept, not indexed, for a job asked for it since, which removing it would delete
      await tx.$queryRaw`SELECT 1 FROM crate WHERE id = ${record.crateId} FOR UPDATE`;
      await tx.$executeRaw`
        DELETE FROM crate WHERE id = ${record.crateId}
        AND NOT EXISTS (SELECT 1 FROM index_job WHERE "crateId" = ${record.crateId} AND id <> ${job.id} AND status <> 'failed')`;
    } else if (record) {
      await tx.crateRecord.update({ where: { id: record.crateId }, data: record.data });
    }
    await tx.indexJob.deleteMany({ where: { OR: [{ id: job.id }, { crateId: job.crateId, status: 'failed' }] } });
    return true;
  });

/**
 * Marks a job failed with `error`'s message, and the stage and item of its `progress`, replacing any earlier failure of its crate.
 * Writes nothing and returns false if `workerId` no longer holds the claim
 */
export const fail = (prisma: PrismaClient, workerId: string, job: Job, error: unknown, progress: Progress) =>
  prisma.$transaction(async (tx) => {
    if (!(await holdsClaim(tx, workerId, job))) {
      return false;
    }
    await markFailed(tx, job, { error: String(error), stage: progress.stage, failedOn: progress.on });
    return true;
  });
