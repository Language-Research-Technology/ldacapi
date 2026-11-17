import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ocflStorage } from '../../test/app.ts';
import { collection, crate } from '../../test/crate-builder.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { prisma } from '../prisma.ts';
import { openRepository } from '../repository/repository.ts';
import { createIndexQueue, type IndexQueue, WORKER_SILENT_MILLISECONDS } from './index-queue.ts';

const A = 'arcp://name,a';
const B = 'arcp://name,b';

const { ocflRoot } = ocflStorage({ crates: [crate(collection(A)), crate(collection(B))] });

let queue: IndexQueue;

const jobs = () => prisma.indexJob.findMany({ select: { crateId: true, kind: true, status: true }, orderBy: [{ crateId: 'asc' }, { id: 'asc' }] });

/** A job for `crateId` as a worker would have left it */
const job = (crateId: string, data: Partial<Prisma.IndexJobUncheckedCreateInput> = {}) => prisma.indexJob.create({ data: { crateId, kind: 'index', ...data } });

const record = (id: string, data: Partial<Prisma.CrateRecordUncheckedCreateInput> = {}) => prisma.crateRecord.create({ data: { id, ...data } });

const INDEXED = { name: 'A', indexedVersion: 2, indexedAt: new Date('2026-11-15T08:00:00Z'), entities: 5, files: 3 };

beforeAll(async () => {
  queue = createIndexQueue({ prisma, repository: await openRepository(ocflRoot()) });
});

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE index_job, crate, index_worker CASCADE`;
});

afterAll(async () => {
  await prisma.$executeRaw`TRUNCATE index_job, crate, index_worker CASCADE`;
  await prisma.$disconnect();
});

describe('asking for a job', () => {
  it.each([
    ['index', (crateId: string) => queue.index(crateId)],
    ['reindex', (crateId: string) => queue.reindex(crateId)],
    ['delete', (crateId: string) => queue.delete(crateId)],
  ])('queues a %s job, listing the crate', async (kind, ask) => {
    await ask(A);

    expect(await jobs()).toEqual([{ crateId: A, kind, status: 'waiting' }]);
    expect(await queue.crate(A)).toEqual({ id: A, name: null, state: kind === 'delete' ? 'deleting' : 'queued' });
  });

  it('adds nothing when asked again while a job waits', async () => {
    await queue.index(A);
    await queue.index(A);

    expect(await jobs()).toEqual([{ crateId: A, kind: 'index', status: 'waiting' }]);
  });

  it.each([
    ['index', 'reindex', 'reindex'],
    ['reindex', 'index', 'reindex'],
    ['index', 'delete', 'delete'],
    ['delete', 'index', 'index'],
  ] as const)('turns a waiting %s into a %s, leaving a %s', async (waiting, asked, left) => {
    await queue[waiting](A);
    await queue[asked](A);

    expect(await jobs()).toEqual([{ crateId: A, kind: left, status: 'waiting' }]);
  });

  it('leaves exactly one follow-up when asked while a job runs', async () => {
    await queue.index(A);
    await prisma.indexJob.updateMany({ data: { status: 'running' } });

    await queue.index(A);
    await queue.index(A);

    expect(await jobs()).toEqual([
      { crateId: A, kind: 'index', status: 'running' },
      { crateId: A, kind: 'index', status: 'waiting' },
    ]);
  });

  it('keeps a crate’s record as it was', async () => {
    await record(A, INDEXED);

    await queue.index(A);

    expect(await prisma.crateRecord.findUnique({ where: { id: A } })).toEqual({ id: A, ...INDEXED });
  });

  it.each([
    [{}, 'index'],
    [{ reindex: true }, 'reindex'],
  ])('asks for every crate in the repository, given %o', async (options, kind) => {
    expect((await queue.indexEverything(options)).sort()).toEqual([A, B]);

    expect(await jobs()).toEqual([
      { crateId: A, kind, status: 'waiting' },
      { crateId: B, kind, status: 'waiting' },
    ]);
  });
});

describe('index state', () => {
  it('is not indexed with only a record', async () => {
    await record(A, { name: 'A' });

    expect(await queue.crate(A)).toEqual({ id: A, name: 'A', state: 'not indexed' });
  });

  it('is indexed, with the version, time and counts, once the record has an indexed version', async () => {
    await record(A, INDEXED);

    expect(await queue.crate(A)).toEqual({ id: A, name: 'A', state: 'indexed', version: 2, indexedAt: INDEXED.indexedAt, entities: 5, files: 3 });
  });

  it('is failed, with the error, ahead of the record', async () => {
    const failedAt = new Date('2026-11-16T09:00:00Z');
    await record(A, INDEXED);
    await job(A, { status: 'failed', error: 'Error: broken', failedAt, attempts: 1 });

    expect(await queue.crate(A)).toEqual({ id: A, name: 'A', state: 'failed', error: 'Error: broken', failedAt, attempts: 1 });
  });

  it('is queued while a job waits, ahead of a failed job', async () => {
    await record(A, INDEXED);
    await job(A, { status: 'failed', error: 'Error: broken' });
    await job(A);

    expect(await queue.crate(A)).toMatchObject({ state: 'queued' });
  });

  it.each(['index', 'reindex'] as const)('is indexing, since the job started, while a %s job runs, ahead of one waiting', async (kind) => {
    const startedAt = new Date('2026-11-16T10:00:00Z');
    await record(A);
    await job(A, { kind: 'delete' });
    await job(A, { kind, status: 'running', startedAt });

    expect(await queue.crate(A)).toEqual({ id: A, name: null, state: 'indexing', startedAt });
  });

  it.each(['waiting', 'running'] as const)('is deleting while a delete job is %s', async (status) => {
    await record(A, INDEXED);
    await job(A, { kind: 'delete', status });

    expect(await queue.crate(A)).toMatchObject({ state: 'deleting' });
  });

  it('is unknown for a crate never asked for', async () => {
    expect(await queue.crate(A)).toBeUndefined();
  });

  it('lists every crate, by id', async () => {
    await record(B);
    await record(A, INDEXED);

    expect((await queue.crates()).map(({ id, state }) => [id, state])).toEqual([
      [A, 'indexed'],
      [B, 'not indexed'],
    ]);
  });

  it('counts the crates in each state', async () => {
    await record(A, INDEXED);
    await record(B, INDEXED);
    await record('arcp://name,c');
    await job('arcp://name,c', { status: 'failed' });

    expect(await queue.counts()).toEqual({ 'not indexed': 0, queued: 0, indexing: 0, deleting: 0, indexed: 2, failed: 1 });
  });

  it('lists the failures among the crates asked about', async () => {
    await record(A);
    await record(B);
    await job(A, { status: 'failed', error: 'Error: A' });
    await job(B, { status: 'failed', error: 'Error: B' });

    expect(await queue.failures([B, 'arcp://name,c'])).toEqual([{ crateId: B, error: 'Error: B' }]);
  });
});

describe('whether a worker is running', () => {
  it('is not, with no worker', async () => {
    expect(await queue.workerRunning()).toBe(false);
  });

  it('is not, when every heartbeat is older than a worker stays silent', async () => {
    await prisma.indexWorker.create({ data: { id: 'gone', heartbeatAt: new Date(Date.now() - WORKER_SILENT_MILLISECONDS - 1000) } });

    expect(await queue.workerRunning()).toBe(false);
  });

  it('is, while a heartbeat is fresh', async () => {
    await prisma.indexWorker.create({ data: { id: 'alive', heartbeatAt: new Date() } });

    expect(await queue.workerRunning()).toBe(true);
  });
});
