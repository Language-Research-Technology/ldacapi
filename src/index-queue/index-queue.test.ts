import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ocflStorage } from '../../test/app.ts';
import { collection, crate } from '../../test/crate-builder.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { prisma } from '../prisma.ts';
import { openRepository } from '../repository/repository.ts';
import { countStates, createIndexQueue, type IndexQueue, WORKER_SILENT_MILLISECONDS } from './index-queue.ts';

const A = 'arcp://name,a';
const B = 'arcp://name,b';
const UNDER_A = `${A}/sub`;
const UNDER_UNDER_A = `${UNDER_A}/sub`;
const GONE = 'arcp://name,gone';
const DAMAGED = 'arcp://name,damaged';

const { ocflRoot } = ocflStorage({
  crates: [
    crate(collection(A)),
    crate(collection(B)),
    crate(collection(UNDER_A, { memberOf: A })),
    crate(collection(UNDER_UNDER_A, { memberOf: UNDER_A })),
    crate(collection(DAMAGED)),
  ],
});

let queue: IndexQueue;

const jobs = () => prisma.indexJob.findMany({ select: { crateId: true, kind: true, status: true }, orderBy: [{ crateId: 'asc' }, { id: 'asc' }] });

/** A job for `crateId` as a worker would have left it */
const job = (crateId: string, data: Partial<Prisma.IndexJobUncheckedCreateInput> = {}) => prisma.indexJob.create({ data: { crateId, kind: 'index', ...data } });

const record = (id: string, data: Partial<Prisma.CrateRecordUncheckedCreateInput> = {}) => prisma.crateRecord.create({ data: { id, ...data } });

const INDEXED = { name: 'A', indexedVersion: 2, indexedAt: new Date('2026-11-15T08:00:00Z'), entities: 5, files: 3 };

beforeAll(async () => {
  await writeFile(join(ocflRoot(), 'arcp_name_damaged', '__object__', 'inventory.json'), 'not json');
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
    expect((await queue.indexEverything(options)).sort()).toEqual([A, UNDER_A, UNDER_UNDER_A, B]);

    expect(await jobs()).toEqual([
      { crateId: A, kind, status: 'waiting' },
      { crateId: UNDER_A, kind, status: 'waiting' },
      { crateId: UNDER_UNDER_A, kind, status: 'waiting' },
      { crateId: B, kind, status: 'waiting' },
    ]);
  });

  it('asks, with everything, to delete each listed crate gone from the repository', async () => {
    await record(GONE, INDEXED);

    expect(await queue.indexEverything()).toContain(GONE);

    expect(await jobs()).toContainEqual({ crateId: GONE, kind: 'delete', status: 'waiting' });
  });

  it('asks, with everything, to index a listed crate the repository holds but can’t read, so that it fails', async () => {
    await record(DAMAGED, INDEXED);

    expect(await queue.indexEverything()).toContain(DAMAGED);

    expect(await jobs()).toContainEqual({ crateId: DAMAGED, kind: 'index', status: 'waiting' });
  });

  it.each([
    ['index', (crateId: string) => queue.index(crateId, { under: true })],
    ['reindex', (crateId: string) => queue.reindex(crateId, { under: true })],
  ])('asks to %s a crate and each listed crate under it, by id, one job each', async (kind, ask) => {
    await prisma.crateRecord.createMany({ data: [{ id: UNDER_A }, { id: UNDER_UNDER_A }, { id: B }] });

    expect((await ask(A)).sort()).toEqual([A, UNDER_A, UNDER_UNDER_A]);

    expect(await jobs()).toEqual([
      { crateId: A, kind, status: 'waiting' },
      { crateId: UNDER_A, kind, status: 'waiting' },
      { crateId: UNDER_UNDER_A, kind, status: 'waiting' },
    ]);
  });

  it('leaves out, with those under it, a crate under it that isn’t listed yet, reading only the database', async () => {
    expect(await queue.index(A, { under: true })).toEqual([A]);
  });

  it('asks to delete a crate and each listed crate under it, including one gone from the repository', async () => {
    await prisma.crateRecord.createMany({ data: [{ id: UNDER_UNDER_A }, { id: `${UNDER_A}/gone` }] });

    expect((await queue.delete(UNDER_A, { under: true })).sort()).toEqual([UNDER_A, `${UNDER_A}/gone`, UNDER_UNDER_A].sort());

    expect((await jobs()).map(({ crateId, kind }) => [crateId, kind])).toEqual([
      [UNDER_A, 'delete'],
      [`${UNDER_A}/gone`, 'delete'],
      [UNDER_UNDER_A, 'delete'],
    ]);
  });

  it('asks for only the crate, unless asked for those under it', async () => {
    expect(await queue.index(A)).toEqual([A]);

    expect(await jobs()).toEqual([{ crateId: A, kind: 'index', status: 'waiting' }]);
  });
});

describe('asking to delete everything', () => {
  it('queues one job with no crate, discarding the waiting jobs', async () => {
    await queue.index(A);
    await queue.reindex(B);

    await queue.deleteEverything();

    expect(await jobs()).toEqual([{ crateId: null, kind: 'delete', status: 'waiting' }]);
  });

  it('leaves running jobs to finish, and keeps the records', async () => {
    await record(A, INDEXED);
    await job(A, { status: 'running' });

    await queue.deleteEverything();

    expect(await jobs()).toEqual([
      { crateId: A, kind: 'index', status: 'running' },
      { crateId: null, kind: 'delete', status: 'waiting' },
    ]);
    expect(await prisma.crateRecord.count()).toBe(1);
  });

  it('adds nothing when asked again while it waits', async () => {
    await queue.deleteEverything();
    await queue.deleteEverything();

    expect(await jobs()).toEqual([{ crateId: null, kind: 'delete', status: 'waiting' }]);
  });

  it('keeps a crate asked for afterwards', async () => {
    await queue.deleteEverything();

    await queue.index(A);

    expect(await jobs()).toEqual([
      { crateId: A, kind: 'index', status: 'waiting' },
      { crateId: null, kind: 'delete', status: 'waiting' },
    ]);
  });

  it.each(['waiting', 'running'] as const)('shows every crate as deleting while it is %s', async (status) => {
    await record(A, INDEXED);
    await record(B);
    await prisma.indexJob.create({ data: { kind: 'delete', status } });

    expect(countStates(await queue.crates())).toMatchObject({ deleting: 2, indexed: 0, 'not indexed': 0 });
  });

  it('shows a crate with a running job as indexing', async () => {
    await record(A);
    await job(A, { status: 'running', startedAt: new Date() });
    await queue.deleteEverything();

    expect(await queue.crate(A)).toMatchObject({ state: 'indexing' });
  });

  it('shows a crate asked for afterwards as deleting, as the delete runs first', async () => {
    await queue.deleteEverything();
    await queue.index(A);

    expect(await queue.crate(A)).toMatchObject({ state: 'deleting' });
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

  it('is failed, with the error, its stage, the entity or file it was on, its time and attempt, ahead of the record', async () => {
    const failedAt = new Date('2026-11-16T09:00:00Z');
    await record(A, INDEXED);
    await job(A, { status: 'failed', error: 'Error: broken', stage: 'database index', failedOn: `${A}/object`, failedAt, attempts: 2 });

    expect(await queue.crate(A)).toEqual({
      id: A,
      name: 'A',
      state: 'failed',
      error: 'Error: broken',
      stage: 'database index',
      failedOn: `${A}/object`,
      failedAt,
      attempts: 2,
    });
  });

  it('is queued while a job waits, ahead of a failed job', async () => {
    await record(A, INDEXED);
    await job(A, { status: 'failed', error: 'Error: broken' });
    await job(A);

    expect(await queue.crate(A)).toMatchObject({ state: 'queued' });
  });

  it.each(['index', 'reindex'] as const)('is indexing, with its stage, counter and start, while a %s job runs, ahead of one waiting', async (kind) => {
    const startedAt = new Date('2026-11-16T10:00:00Z');
    await record(A);
    await job(A, { kind: 'delete' });
    await job(A, { kind, status: 'running', startedAt, stage: 'search index', done: 12_000, total: 30_000 });

    expect(await queue.crate(A)).toEqual({ id: A, name: null, state: 'indexing', stage: 'search index', done: 12_000, total: 30_000, startedAt });
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

    expect(countStates(await queue.crates())).toEqual({ 'not indexed': 0, queued: 0, indexing: 0, deleting: 0, indexed: 2, failed: 1 });
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
