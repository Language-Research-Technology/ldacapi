import { beforeEach, expect, it } from 'vitest';
import { ocflTestbed } from '../../test/app.ts';
import { collection, crate } from '../../test/crate-builder.ts';
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
