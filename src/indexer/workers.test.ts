import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ocflTestbed } from '../../test/app.ts';
import { collection, crate } from '../../test/crate-builder.ts';
import { countStates } from '../index-queue/index-queue.ts';
import type { Document } from '../search-backend.ts';
import type { IndexerDeps } from './indexer.ts';

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
    expect(countStates(await indexQueue.crates()).indexed).toBe(MANY.length);
  });
});

/** The status and attempt count of each index job */
const jobs = () => testbed.started.prisma.indexJob.findMany({ select: { status: true, attempts: true }, orderBy: { id: 'asc' } });

/** Asks to index `crateId`, then starts a worker over `deps` */
const startWorker = async (crateId: string, deps: Partial<IndexerDeps> = {}) => {
  await testbed.started.indexQueue.index(crateId);
  return startWorking(deps);
};

const startWorking = async (deps: Partial<IndexerDeps> = {}) => {
  const { indexer } = testbed.started;
  // Imported once the testbed has read its configuration
  const { workTheQueue } = await import('./indexer.ts');
  const stop = new AbortController();
  const working = workTheQueue({ ...indexer, ...deps }, { until: 'aborted', signal: stop.signal, retryMilliseconds: 10, heartbeatMilliseconds: 10 });
  return { stop, working };
};

/**
 * Starts a worker, which claims the job asked for `crateId`, then stops it while the job waits on a lock of every crate
 * record, and lets the job carry on. Resolves once the worker has stopped
 */
const stopWhileRunning = async (crateId: string) => {
  const { prisma, indexQueue } = testbed.started;
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
  const { stop, working } = await startWorking();
  await vi.waitFor(async () => expect(await jobs()).toEqual([{ status: 'running', attempts: 1 }]));

  stop.abort();
  unlock();
  await holding;
  await working;
};

describe('a worker told to stop', () => {
  it('releases its running job once the step it is on is done, as if never tried, and removes its row', async () => {
    await stopWhileRunning(FIRST);

    expect(await jobs()).toEqual([{ status: 'waiting', attempts: 0 }]);
    expect(await testbed.started.prisma.indexWorker.count()).toBe(0);
    expect(await state(FIRST)).toMatchObject({ state: 'queued' });

    await testbed.started.workTheQueue();
    expect(await state(FIRST)).toMatchObject({ state: 'indexed' });
    expect(logs.filter(({ msg }) => msg === 'Job started').map(({ attempt }) => attempt)).toEqual([1, 1]);
  });

  it('records no failure of the job it was running', async () => {
    await stopWhileRunning(UNLICENSED);

    expect(await state(UNLICENSED)).toMatchObject({ state: 'queued' });
  });
});

/** opensearch-js's error for search that can't be reached */
const connectionError = () => Object.assign(new Error('connect ECONNREFUSED'), { name: 'ConnectionError' });

/** Search whose bulk writes fail as if it can't be reached, `times` times */
const searchDown = (times: number): Partial<IndexerDeps> => {
  const { search } = testbed.started.indexer;
  let failures = 0;
  return {
    search: {
      ...search,
      index: async (documents) => {
        if (failures++ < times) {
          throw connectionError();
        }
        await search.index(documents);
      },
    },
  };
};

/** The OpenSearch client, its ping failing with `error` */
const pingFailing = (error: Error) => ({
  opensearch: Object.assign(Object.create(testbed.started.opensearch), { ping: async () => Promise.reject(error) }),
});

describe('a worker in an outage', () => {
  it('pauses, then once the database and search answer, releases the job and runs it again', async () => {
    const { working, stop } = await startWorker(FIRST, searchDown(1));

    await vi.waitFor(async () => expect(await state(FIRST)).toMatchObject({ state: 'indexed' }));
    stop.abort();
    await working;

    expect(logs.map(({ msg }) => msg)).toEqual(
      expect.arrayContaining(['Paused: the database or search is unavailable', 'Resumed: the database and search answer']),
    );
    expect(logs.filter(({ msg }) => msg === 'Job started').map(({ attempt }) => attempt)).toEqual([1, 1]);
  });

  it('keeps waiting while search can’t be reached, and when told to stop, releases the job', async () => {
    const { working, stop } = await startWorker(FIRST, { ...searchDown(Infinity), ...pingFailing(connectionError()) });

    await vi.waitFor(() => expect(logs).toContainEqual(expect.objectContaining({ msg: 'Still unavailable' })));
    stop.abort();
    await working;

    expect(await jobs()).toEqual([{ status: 'waiting', attempts: 0 }]);
  });

  it('pauses on starting, then starts once the database and search answer', async () => {
    const { search } = testbed.started.indexer;
    let failed = false;
    const createIndex = async () => {
      if (!failed) {
        failed = true;
        throw connectionError();
      }
      await search.createIndex();
    };
    const { working, stop } = await startWorker(FIRST, { search: { ...search, createIndex } });

    await vi.waitFor(async () => expect(await state(FIRST)).toMatchObject({ state: 'indexed' }));
    stop.abort();
    await working;

    expect(logs.map(({ msg }) => msg)).toContain('Resumed: the database and search answer');
  });

  it('stops working the queue when a check fails for another reason', async () => {
    const { working } = await startWorker(FIRST, { ...searchDown(1), ...pingFailing(new Error('Not an outage')) });

    await expect(working).rejects.toThrow('Not an outage');
  });
});

/** Search whose bulk writes wait until let through, then do `then` */
const searchHeld = (then: (documents: Document[]) => Promise<void>) => {
  const { promise: through, resolve: letThrough } = Promise.withResolvers<void>();
  const { search } = testbed.started.indexer;
  const index = async (documents: Document[]) => {
    await through;
    await then(documents);
  };
  return { search: { ...search, index }, letThrough };
};

describe('a heartbeat that fails', () => {
  it('is logged, and the job carries on', async () => {
    const { prisma } = testbed.started;
    // Only the heartbeat updates a running job and leaves it running
    await prisma.$executeRawUnsafe(`CREATE FUNCTION refuse_heartbeat() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Refused'; END $$`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER refuse_heartbeat BEFORE UPDATE ON index_job FOR EACH ROW WHEN (OLD.status = 'running' AND NEW.status = 'running') EXECUTE FUNCTION refuse_heartbeat()`,
    );
    try {
      const { search, letThrough } = searchHeld((documents) => testbed.started.indexer.search.index(documents));
      const { working, stop } = await startWorker(FIRST, { search });

      await vi.waitFor(() => expect(logs).toContainEqual(expect.objectContaining({ level: 40, msg: 'Heartbeat failed' })));
      letThrough();
      await vi.waitFor(async () => expect(await state(FIRST)).toMatchObject({ state: 'indexed' }));
      stop.abort();
      await working;
    } finally {
      await prisma.$executeRawUnsafe('DROP FUNCTION refuse_heartbeat CASCADE');
    }
  });
});

describe('a job whose claim is taken away while it runs', () => {
  /** Runs the job until its search write, takes its claim away, then lets the write do `then` until `finished` */
  const takenAway = async (then: (documents: Document[]) => Promise<void>, finished: () => void) => {
    const { search, letThrough } = searchHeld(then);
    const { working, stop } = await startWorker(FIRST, { search });
    await vi.waitFor(async () => expect(await state(FIRST)).toMatchObject({ state: 'indexing' }));
    // As if judged dead and claimed by a live worker
    await testbed.started.prisma.indexWorker.create({ data: { id: 'another' } });
    await testbed.started.prisma.indexJob.updateMany({ data: { workerId: 'another' } });

    letThrough();
    await vi.waitFor(finished);
    stop.abort();
    await working;
  };

  const dropped = () => expect(logs).toContainEqual(expect.objectContaining({ crateId: FIRST, msg: 'Result dropped: another worker holds the job' }));

  it('has its result dropped', async () => {
    await takenAway((documents) => testbed.started.indexer.search.index(documents), dropped);

    expect(await state(FIRST)).toMatchObject({ state: 'indexing' });
  });

  it('has its failure dropped', async () => {
    await takenAway(async () => {
      throw new Error('Refused');
    }, dropped);

    expect(await state(FIRST)).toMatchObject({ state: 'indexing' });
  });

  it('is left to the worker holding it after an outage', async () => {
    await takenAway(
      async () => {
        throw connectionError();
      },
      () => expect(logs).toContainEqual(expect.objectContaining({ msg: 'Resumed: the database and search answer' })),
    );

    expect(await jobs()).toEqual([{ status: 'running', attempts: 1 }]);
  });
});

it('a worker that can’t prepare the search index stops working the queue', async () => {
  const { search } = testbed.started.indexer;

  const { working } = await startWorking({ search: { ...search, createIndex: () => Promise.reject(new Error('Mapping differs')) } });

  await expect(working).rejects.toThrow('Mapping differs');
});
