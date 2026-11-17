import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ocflTestbed } from '../../test/app.ts';
import { type Crate, collection, crate, file, fileDescribedButNotHeld, object } from '../../test/crate-builder.ts';

const logs = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('../logger.ts', async () => (await import('../../test/logs.ts')).capturingLogger(logs, 'debug'));

const ROOT = 'arcp://name,indexer';
const OBJECT = `${ROOT}/object`;
const UNLICENSED = 'arcp://name,unlicensed';
const NO_METADATA_LICENCE = 'arcp://name,no-metadata-licence';
const ORPHAN = 'arcp://name,orphan';
const NO_METADATA = 'arcp://name,no-metadata';
const OTHER = 'arcp://name,other';
const UNNAMED = 'arcp://name,unnamed';
const GONE = 'arcp://name,gone';

/** `built` without the metadata descriptor's licence */
const withoutMetadataLicence = (built: Crate): Crate => ({
  ...built,
  metadata: {
    ...built.metadata,
    '@graph': built.metadata['@graph'].map(({ license, ...entity }) => (entity['@id'] === 'ro-crate-metadata.json' ? entity : { ...entity, license })),
  },
});

const testbed = ocflTestbed(
  crate(collection(ROOT, { name: 'Indexer', hasMember: [OBJECT] }), [
    object(OBJECT, { memberOf: ROOT, hasPart: ['held.txt', 'missing.txt'] }),
    file('held.txt', { content: 'Held text', encodingFormat: 'text/plain', isPartOf: OBJECT }),
    fileDescribedButNotHeld('missing.txt', { encodingFormat: 'text/plain', isPartOf: OBJECT }),
  ]),
  crate(collection(UNLICENSED, { licence: null })),
  withoutMetadataLicence(crate(collection(NO_METADATA_LICENCE))),
  crate(collection(ORPHAN, { memberOf: 'arcp://name,not-in-the-repository' })),
  crate(collection(OTHER)),
  crate({ entity: { '@id': UNNAMED, '@type': ['Dataset', 'RepositoryCollection'], conformsTo: { '@id': 'https://w3id.org/ldac/profile#Collection' } } }),
);

const details = { message: 'Changed by a test', user: { name: 'Test' } };

/** Adds a collection crate `crateId` to the repository */
const addCrate = (crateId: string) =>
  testbed.started.repository.create(crateId, details, (draft) => draft.write('ro-crate-metadata.json', JSON.stringify(crate(collection(crateId)).metadata)));

const run = async (ask: () => Promise<unknown>) => {
  await ask();
  await testbed.started.workTheQueue();
};

const index = (crateId: string) => run(() => testbed.started.indexQueue.index(crateId));

const state = (crateId: string) => testbed.started.indexQueue.crate(crateId);

const searchableIds = async () => (await testbed.search({ query: '', limit: 100 })).entities.map(({ id }: { id: string }) => id);

const rowIds = async () => (await testbed.started.prisma.entity.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map(({ id }) => id);

beforeEach(async () => {
  await testbed.started.emptyEverything();
  logs.length = 0;
});

describe('an index job', () => {
  it('indexes the crate at its head version, with its counts, searchable, then is removed', async () => {
    await index(ROOT);

    expect(await state(ROOT)).toMatchObject({ name: 'Indexer', state: 'indexed', version: 1, entities: 4, files: 2 });
    expect(await rowIds()).toEqual([ROOT, OBJECT, `${ROOT}/held.txt`, `${ROOT}/missing.txt`].sort());
    expect((await testbed.search({ query: 'Held' })).entities.map(({ id }: { id: string }) => id)).toEqual([`${ROOT}/held.txt`]);
    expect(await testbed.started.prisma.indexJob.count()).toBe(0);
  });

  it('logs when it starts and finishes', async () => {
    await index(ROOT);

    expect(logs).toContainEqual(expect.objectContaining({ level: 30, crateId: ROOT, kind: 'index', attempt: 1, msg: 'Job started' }));
    expect(logs).toContainEqual(expect.objectContaining({ level: 30, crateId: ROOT, kind: 'index', version: 1, entities: 4, files: 2, msg: 'Job finished' }));
  });

  it('indexes a file the crate describes but doesn’t hold, logging that it can’t be read', async () => {
    await index(ROOT);

    const missing = await testbed.started.prisma.file.findUniqueOrThrow({ where: { id: `${ROOT}/missing.txt` } });
    expect(missing.meta).toEqual({ ocflObject: ROOT, ocflPath: 'missing.txt' });
    expect(logs.filter(({ msg }) => msg === 'Cannot read file').map(({ module }) => module)).toEqual(['indexer/rows', 'indexer/documents']);
  });

  it('skips a crate whose head version is already indexed', async () => {
    await index(ROOT);
    const before = await state(ROOT);

    await index(ROOT);

    expect(await state(ROOT)).toEqual(before);
    expect(logs).toContainEqual(expect.objectContaining({ level: 20, crateId: ROOT, version: 1, msg: 'Skipped: already indexed' }));
  });

  it('indexes a new head version', async () => {
    await index(OTHER);
    const ocflObject = await testbed.started.repository.open(OTHER);
    const metadata = JSON.parse(await (ocflObject.head.files.get('ro-crate-metadata.json')?.text() ?? '{}'));
    metadata['@graph'][1].name = 'Renamed';
    await ocflObject.update(details, (draft) => draft.write('ro-crate-metadata.json', JSON.stringify(metadata)));

    await index(OTHER);

    expect(await state(OTHER)).toMatchObject({ name: 'Renamed', state: 'indexed', version: 2 });
    expect((await testbed.search({ query: 'Renamed' })).entities.map(({ id }: { id: string }) => id)).toEqual([OTHER]);
  });

  it('records no name for a crate without one', async () => {
    await index(UNNAMED);

    expect(await state(UNNAMED)).toMatchObject({ name: null, state: 'indexed' });
  });

  it('fails for a crate with no licence and no default, keeping the error', async () => {
    await index(UNLICENSED);

    expect(await state(UNLICENSED)).toMatchObject({
      state: 'failed',
      error: 'Error: The crate has no licence, and none is configured as the default',
      attempts: 1,
    });
    expect(logs).toContainEqual(expect.objectContaining({ level: 50, crateId: UNLICENSED, kind: 'index', msg: 'Job failed' }));
  });

  it('fails for a crate with no metadata licence and no default', async () => {
    await index(NO_METADATA_LICENCE);

    expect(await state(NO_METADATA_LICENCE)).toMatchObject({
      state: 'failed',
      error: 'Error: The crate has no metadata licence, and none is configured as the default',
    });
  });

  it('succeeds for a crate that isn’t in the repository, no longer listing it', async () => {
    await index('arcp://name,missing');

    expect(await state('arcp://name,missing')).toBeUndefined();
    expect(await testbed.started.prisma.indexJob.count()).toBe(0);
  });

  it('deletes the indexes of a crate gone from the repository, and no longer lists it', async () => {
    await addCrate(GONE);
    await index(GONE);
    await index(OTHER);
    await testbed.started.repository.remove(GONE);

    await index(GONE);

    expect(await state(GONE)).toBeUndefined();
    expect(await rowIds()).toEqual([OTHER]);
    expect(await searchableIds()).toEqual([OTHER]);
  });

  it('fails for an object with no crate metadata', async () => {
    await testbed.started.repository.create(NO_METADATA, details, (draft) => draft.write('readme.txt', 'Not a crate'));

    await index(NO_METADATA);

    expect(await state(NO_METADATA)).toMatchObject({ state: 'failed', error: `Error: No ro-crate-metadata.json in ${NO_METADATA}` });
  });

  it('is replaced, once failed, by the next job for the crate', async () => {
    await index(UNLICENSED);

    await run(() => testbed.started.indexQueue.delete(UNLICENSED));

    expect(await state(UNLICENSED)).toMatchObject({ state: 'not indexed' });
    expect(await testbed.started.prisma.indexJob.count()).toBe(0);
  });

  it('keeps a failure until the next job for the crate, whatever it is', async () => {
    await index(UNLICENSED);
    await index(UNLICENSED);

    expect(await testbed.started.prisma.indexJob.findMany({ select: { status: true } })).toEqual([{ status: 'failed' }]);
  });

  it('indexes a crate whose parent collection can’t be read as its own top collection, with a warning', async () => {
    await index(ORPHAN);

    expect(await testbed.started.prisma.entity.findUniqueOrThrow({ where: { id: ORPHAN }, select: { rootCollection: true } })).toEqual({
      rootCollection: null,
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 40,
        crateId: ORPHAN,
        parent: 'arcp://name,not-in-the-repository',
        msg: 'Cannot read parent collection; using the highest found',
      }),
    );
  });
});

describe('a reindex job', () => {
  it('rebuilds a crate already indexed at its head version', async () => {
    await index(ROOT);
    const before = await state(ROOT);

    await run(() => testbed.started.indexQueue.reindex(ROOT));

    const after = await state(ROOT);
    expect(after).toMatchObject({ state: 'indexed', version: 1, entities: 4, files: 2 });
    expect(after).not.toEqual(before);
    expect(await rowIds()).toHaveLength(4);
  });
});

describe('a delete job', () => {
  it('leaves the crate listed as not indexed, with no rows or documents', async () => {
    await index(ROOT);
    await index(OTHER);

    await run(() => testbed.started.indexQueue.delete(ROOT));

    expect(await state(ROOT)).toEqual({ id: ROOT, name: 'Indexer', state: 'not indexed' });
    expect(await rowIds()).toEqual([OTHER]);
    expect(await searchableIds()).toEqual([OTHER]);
  });
});

describe('a delete job for a crate gone from the repository, asked for by indexing everything', () => {
  it('removes the crate from search and the crates listed', async () => {
    await addCrate(GONE);
    await index(GONE);
    await testbed.started.repository.remove(GONE);

    await run(() => testbed.started.indexQueue.indexEverything());

    expect((await testbed.started.indexQueue.crates()).map(({ id }) => id)).not.toContain(GONE);
    expect(await searchableIds()).not.toContain(GONE);
  });
});

describe('deleting everything', () => {
  it('empties both indexes and leaves every crate listed as not indexed', async () => {
    await index(ROOT);
    await index(OTHER);

    await run(() => testbed.started.indexQueue.deleteEverything());

    expect((await testbed.started.indexQueue.crates()).map(({ id, state }) => [id, state])).toEqual(
      [
        [ROOT, 'not indexed'],
        [OTHER, 'not indexed'],
      ].sort(),
    );
    expect(await rowIds()).toEqual([]);
    expect(await searchableIds()).toEqual([]);
    expect(await testbed.started.prisma.indexJob.count()).toBe(0);
  });

  it('logs when it starts and finishes', async () => {
    await run(() => testbed.started.indexQueue.deleteEverything());

    expect(logs).toContainEqual(expect.objectContaining({ level: 30, crateId: null, kind: 'delete', msg: 'Job finished' }));
  });

  it('then indexes a crate asked for after it', async () => {
    await index(ROOT);

    await run(async () => {
      await testbed.started.indexQueue.deleteEverything();
      await testbed.started.indexQueue.index(OTHER);
    });

    expect(await state(ROOT)).toMatchObject({ state: 'not indexed' });
    expect(await state(OTHER)).toMatchObject({ state: 'indexed' });
    expect(await rowIds()).toEqual([OTHER]);
  });

  it('waits for jobs running elsewhere, and so do the crates asked for after it', async () => {
    const { prisma } = testbed.started;
    await prisma.crateRecord.createMany({ data: [{ id: ROOT }, { id: OTHER }] });
    await prisma.indexJob.create({ data: { crateId: ROOT, kind: 'index', status: 'running', workerId: 'elsewhere' } });
    await testbed.started.indexQueue.deleteEverything();
    await testbed.started.indexQueue.index(OTHER);

    await testbed.started.workTheQueue();

    expect(await prisma.indexJob.findMany({ select: { crateId: true, status: true }, orderBy: { id: 'asc' } })).toEqual([
      { crateId: ROOT, status: 'running' },
      { crateId: null, status: 'waiting' },
      { crateId: OTHER, status: 'waiting' },
    ]);
  });

  it('replaces an earlier failure of deleting everything', async () => {
    const { prisma } = testbed.started;
    await prisma.indexJob.create({ data: { kind: 'delete', status: 'failed', error: 'Error: earlier' } });

    await run(() => testbed.started.indexQueue.deleteEverything());

    expect(await prisma.indexJob.count()).toBe(0);
  });
});

describe('working the queue', () => {
  it('leaves a waiting job whose crate has one running elsewhere', async () => {
    await testbed.started.prisma.crateRecord.createMany({ data: [{ id: ROOT }, { id: OTHER }] });
    await testbed.started.prisma.indexJob.createMany({
      data: [
        { crateId: ROOT, kind: 'index', status: 'running', workerId: 'elsewhere' },
        { crateId: ROOT, kind: 'index' },
        { crateId: OTHER, kind: 'index' },
      ],
    });

    await testbed.started.workTheQueue();

    expect(await testbed.started.prisma.indexJob.findMany({ select: { crateId: true, status: true }, orderBy: { id: 'asc' } })).toEqual([
      { crateId: ROOT, status: 'running' },
      { crateId: ROOT, status: 'waiting' },
    ]);
    expect(await state(OTHER)).toMatchObject({ state: 'indexed' });
  });

  describe('until stopped', () => {
    const stop = new AbortController();
    let working: Promise<void>;

    afterEach(async () => {
      stop.abort();
      await working;
    });

    it('runs jobs as they are asked for, beating its heart, and stops when told to', async () => {
      const { indexer, indexQueue, prisma } = testbed.started;
      // Imported once the testbed has read its configuration
      const { workTheQueue } = await import('./indexer.ts');
      working = workTheQueue(indexer, { until: 'aborted', signal: stop.signal, heartbeatMilliseconds: 10 });

      await vi.waitFor(async () => expect(await indexQueue.workerRunning()).toBe(true));
      const { heartbeatAt } = await prisma.indexWorker.findFirstOrThrow();
      await vi.waitFor(async () => expect((await prisma.indexWorker.findFirstOrThrow()).heartbeatAt).not.toEqual(heartbeatAt));

      await indexQueue.index(OTHER);
      await vi.waitFor(async () => expect(await state(OTHER)).toMatchObject({ state: 'indexed' }), { timeout: 10_000 });

      stop.abort();
      await working;
      expect(await indexQueue.workerRunning()).toBe(false);
    });
  });
});
