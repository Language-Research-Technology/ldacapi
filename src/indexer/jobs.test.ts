import { beforeEach, expect, it, vi } from 'vitest';
import { ocflTestbed } from '../../test/app.ts';
import { collection, crate } from '../../test/crate-builder.ts';
import { holdTransaction, lockWaits } from '../../test/transactions.ts';
import type { Job } from './jobs.ts';

const CRATE = 'arcp://name,claimed';

const testbed = ocflTestbed(crate(collection(CRATE)));

beforeEach(async () => {
  await testbed.started.emptyEverything();
});

it('refuses the result of a job whose claim was taken away, keeping the new claim', async () => {
  const { prisma, indexQueue } = testbed.started;
  // Imported once the testbed has read its configuration
  const { claim, returnDeadWorkersJobs, succeed } = await import('./jobs.ts');
  await indexQueue.index(CRATE);
  const job = (await claim(prisma, 'judged-dead')) as Job;
  await prisma.indexWorker.update({ where: { id: 'judged-dead' }, data: { heartbeatAt: new Date(Date.now() - 10 * 60 * 1000) } });
  await returnDeadWorkersJobs(prisma);
  expect(await claim(prisma, 'alive')).toMatchObject({ id: job.id, attempts: 2 });

  expect(await succeed(prisma, 'judged-dead', job, { crateId: CRATE, data: { indexedVersion: 1, indexedAt: new Date(), entities: 1, files: 0 } })).toBe(false);

  expect(await indexQueue.crate(CRATE)).toMatchObject({ state: 'indexing' });
});

it('records a worker judged dead as alive again when it next claims, so its new job isn’t taken as a dead worker’s', async () => {
  const { prisma, indexQueue } = testbed.started;
  // Imported once the testbed has read its configuration
  const { claim, heartbeat } = await import('./jobs.ts');
  await heartbeat(prisma, 'back');
  // Its row removed by another worker that judged it dead
  await prisma.indexWorker.delete({ where: { id: 'back' } });
  await indexQueue.index(CRATE);
  expect(await claim(prisma, 'back')).toMatchObject({ crateId: CRATE, attempts: 1 });

  expect(await claim(prisma, 'other')).toBeUndefined();

  expect(await indexQueue.crate(CRATE)).toMatchObject({ state: 'indexing' });
});

it('drops a released job when a job for its crate is asked for meanwhile', async () => {
  const { prisma, indexQueue } = testbed.started;
  // Imported once the testbed has read its configuration
  const { claim, release } = await import('./jobs.ts');
  await indexQueue.index(CRATE);
  const job = (await claim(prisma, 'stopping')) as Job;
  const asking = await holdTransaction(prisma, (tx) => tx.indexJob.create({ data: { crateId: CRATE, kind: 'reindex' } }));

  const releasing = release(prisma, 'stopping', job);
  await vi.waitFor(async () => expect(await lockWaits(prisma)).toBe(1));
  await asking.commit();
  await releasing;

  expect(await prisma.indexJob.findMany({ select: { kind: true, status: true } })).toEqual([{ kind: 'reindex', status: 'waiting' }]);
});

it('claims one job at a time, so deleting everything never runs beside a crate’s job', async () => {
  const { prisma } = testbed.started;
  // Imported once the testbed has read its configuration
  const { claim } = await import('./jobs.ts');
  // A crate's job ahead of deleting everything, as when returned to waiting
  await prisma.crateRecord.create({ data: { id: CRATE } });
  await prisma.indexJob.create({ data: { crateId: CRATE, kind: 'index' } });
  await prisma.indexJob.create({ data: { kind: 'delete' } });
  // Holds the worker 'slow' part-way through claiming, its crate's job locked but not yet seen running
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION hold_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(9, 9); RETURN NEW; END $$`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER hold_claim BEFORE UPDATE ON index_job FOR EACH ROW WHEN (NEW."workerId" = 'slow') EXECUTE FUNCTION hold_claim()`,
  );
  try {
    const holding = await holdTransaction(prisma, (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(9, 9)`);
    const slow = claim(prisma, 'slow');
    await vi.waitFor(async () => expect(await lockWaits(prisma)).toBe(1));

    let fastClaimed = false;
    const fast = claim(prisma, 'fast').finally(() => {
      fastClaimed = true;
    });
    await vi.waitFor(async () => expect(fastClaimed || (await lockWaits(prisma)) === 2).toBe(true));
    await holding.commit();

    expect(await slow).toMatchObject({ crateId: CRATE });
    expect(await fast).toBeUndefined();
  } finally {
    await prisma.$executeRawUnsafe('DROP FUNCTION hold_claim CASCADE');
  }
});
