import type { IndexJobKind, PrismaClient } from '../generated/prisma/client.ts';

export type Job = { id: number; crateId: string; kind: IndexJobKind; attempts: number };

/** Records a worker as alive, now */
export const heartbeat = async (prisma: PrismaClient, workerId: string) => {
  const heartbeatAt = new Date();
  await prisma.indexWorker.upsert({ where: { id: workerId }, create: { id: workerId, heartbeatAt }, update: { heartbeatAt } });
};

export const removeWorker = async (prisma: PrismaClient, workerId: string) => {
  await prisma.indexWorker.deleteMany({ where: { id: workerId } });
};

/** Claims the oldest waiting job whose crate has none running, for `workerId` */
export async function claim(prisma: PrismaClient, workerId: string): Promise<Job | undefined> {
  const [job] = await prisma.$queryRaw<Job[]>`
    UPDATE index_job SET status = 'running', "workerId" = ${workerId}, attempts = attempts + 1, "startedAt" = now()
    WHERE id = (
      SELECT id FROM index_job waiting
      WHERE status = 'waiting' AND NOT EXISTS (SELECT 1 FROM index_job running WHERE running."crateId" = waiting."crateId" AND running.status = 'running')
      ORDER BY id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "crateId", kind, attempts`;
  return job;
}

/** Removes a job that has done its work, and any earlier failure of its crate it makes stale */
export async function succeed(prisma: PrismaClient, workerId: string, job: Job) {
  await prisma.indexJob.deleteMany({
    where: {
      OR: [
        { id: job.id, workerId, status: 'running' },
        { crateId: job.crateId, status: 'failed' },
      ],
    },
  });
}

/** Marks a job failed with `error`, replacing any earlier failure of its crate */
export async function fail(prisma: PrismaClient, workerId: string, job: Job, error: unknown) {
  await prisma.$transaction([
    prisma.indexJob.deleteMany({ where: { crateId: job.crateId, status: 'failed' } }),
    prisma.indexJob.updateMany({
      where: { id: job.id, workerId, status: 'running' },
      data: { status: 'failed', error: String(error), failedAt: new Date() },
    }),
  ]);
}
