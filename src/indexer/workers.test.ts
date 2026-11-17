import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ocflTestbed } from '../../test/app.ts';
import { collection, crate } from '../../test/crate-builder.ts';

const logs = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('../logger.ts', async () => (await import('../../test/logs.ts')).capturingLogger(logs, 'debug'));

const FIRST = 'arcp://name,first';

const MANY = Array.from({ length: 8 }, (_, n) => `arcp://name,many-${n}`);

const UNLICENSED = 'arcp://name,unlicensed';

const testbed = ocflTestbed(crate(collection(FIRST)), crate(collection(UNLICENSED, { licence: null })), ...MANY.map((id) => crate(collection(id))));

const state = (crateId: string) => testbed.started.indexQueue.crate(crateId);

const TEN_MINUTES_AGO = () => new Date(Date.now() - 10 * 60 * 1000);

/** A worker last heard from ten minutes ago, running a job for `crateId` on its `attempts`th attempt */
const deadWorkerRunning = async (crateId: string, attempts: number) => {
  const { prisma } = testbed.started;
  await prisma.indexWorker.create({ data: { id: 'dead', heartbeatAt: TEN_MINUTES_AGO() } });
  await prisma.crateRecord.create({ data: { id: crateId } });
  await prisma.indexJob.create({ data: { crateId, kind: 'index', status: 'running', workerId: 'dead', attempts, startedAt: TEN_MINUTES_AGO() } });
};

beforeEach(async () => {
  await testbed.started.emptyEverything();
  logs.length = 0;
});

describe('a dead worker', () => {
  it('has its job returned to waiting and run, and its row removed', async () => {
    await deadWorkerRunning(FIRST, 1);

    await testbed.started.workTheQueue();

    expect(await state(FIRST)).toMatchObject({ state: 'indexed' });
    expect(await testbed.started.prisma.indexWorker.count()).toBe(0);
  });

  it('has its job run again after a second return', async () => {
    await deadWorkerRunning(FIRST, 2);

    await testbed.started.workTheQueue();

    expect(await state(FIRST)).toMatchObject({ state: 'indexed' });
  });

  it('has its job dropped for one asked for since, which runs', async () => {
    await deadWorkerRunning(FIRST, 1);
    await testbed.started.indexQueue.delete(FIRST);

    await testbed.started.workTheQueue();

    expect(await state(FIRST)).toMatchObject({ state: 'not indexed' });
    expect(await testbed.started.prisma.indexJob.count()).toBe(0);
  });

  it('has its job marked failed on its third return', async () => {
    await deadWorkerRunning(FIRST, 3);

    await testbed.started.workTheQueue();

    expect(await state(FIRST)).toMatchObject({ state: 'failed', error: 'Error: Its worker died on each of 3 attempts', attempts: 3 });
    expect(logs).toContainEqual(expect.objectContaining({ level: 50, crateId: FIRST, attempts: 3, msg: 'Job failed: its worker died' }));
  });
});

describe('two runs working the queue at once', () => {
  it('index each crate once', async () => {
    const { indexer, indexQueue } = testbed.started;
    // Imported once the testbed has read its configuration
    const { workTheQueue } = await import('./indexer.ts');
    for (const id of MANY) {
      await indexQueue.index(id);
    }

    await Promise.all([workTheQueue(indexer, { until: 'empty' }), workTheQueue(indexer, { until: 'empty' })]);

    const started = logs.filter(({ msg }) => msg === 'Job started').map(({ crateId }) => crateId);
    expect(started.sort()).toEqual([...MANY].sort());
    expect((await indexQueue.counts()).indexed).toBe(MANY.length);
  });
});

/** The status and attempt count of each index job */
const jobs = () => testbed.started.prisma.indexJob.findMany({ select: { status: true, attempts: true }, orderBy: { id: 'asc' } });

/**
 * Starts a worker, which claims the job asked for `crateId`, then stops it while the job waits on a lock of every crate
 * record. Returns a function that lets the job, now unowned, carry on, resolving once its result is refused
 */
const stopWhileRunning = async (crateId: string) => {
  const { indexer, indexQueue, prisma } = testbed.started;
  // Imported once the testbed has read its configuration
  const { workTheQueue } = await import('./indexer.ts');
  await indexQueue.index(crateId);
  const { promise: locked, resolve: lock } = Promise.withResolvers<void>();
  const { promise: unlocked, resolve: unlock } = Promise.withResolvers<void>();
  const holding = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`LOCK TABLE crate IN ACCESS EXCLUSIVE MODE`;
      lock();
      await unlocked;
    },
    { timeout: 60_000 },
  );
  await locked;
  const stop = new AbortController();
  const working = workTheQueue(indexer, { until: 'aborted', signal: stop.signal });
  await vi.waitFor(async () => expect(await jobs()).toEqual([{ status: 'running', attempts: 1 }]));

  stop.abort();
  await working;

  return async () => {
    unlock();
    await holding;
    await vi.waitFor(() => expect(logs).toContainEqual(expect.objectContaining({ crateId, msg: 'Result dropped: another worker holds the job' })));
  };
};

describe('a worker told to stop', () => {
  it('releases its running job at once, as if never tried, and removes its row', async () => {
    const carryOn = await stopWhileRunning(FIRST);

    expect(await jobs()).toEqual([{ status: 'waiting', attempts: 0 }]);
    expect(await testbed.started.prisma.indexWorker.count()).toBe(0);

    await carryOn();
    expect(await state(FIRST)).toMatchObject({ state: 'queued' });

    await testbed.started.workTheQueue();
    expect(await state(FIRST)).toMatchObject({ state: 'indexed' });
    expect(logs.filter(({ msg }) => msg === 'Job started').map(({ attempt }) => attempt)).toEqual([1, 1]);
  });

  it('records no failure of the job it was running', async () => {
    const carryOn = await stopWhileRunning(UNLICENSED);

    await carryOn();

    expect(await state(UNLICENSED)).toMatchObject({ state: 'queued' });
  });
});
