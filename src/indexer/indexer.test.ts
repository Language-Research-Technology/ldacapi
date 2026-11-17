import { glob, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
const LARGE = 'arcp://name,large';
const SEVERAL_PARENTS = 'arcp://name,several-parents';
const UNPROFILED = 'arcp://name,unprofiled';
const LONG_TEXT = 'arcp://name,long-text';
const UNREADABLE = 'arcp://name,unreadable';
// 5 MB, its last words past the first 1 MB
const FIVE_MB = `${'early '.repeat(100_000)}${'within '.repeat(60_000)}${'beyond '.repeat(600_000)}`.slice(0, 5_000_000);
// More rows and documents than fit in one batch, and more text than fits in one bulk request,
// each text short enough for search to highlight
const LARGE_TEXTS = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt'];
const LARGE_AUDIO = Array.from({ length: 2100 }, (_, i) => `audio/${i}.wav`);

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
  crate({ entity: { '@id': UNPROFILED, '@type': 'Dataset', name: 'Unprofiled' } }),
  crate(collection(SEVERAL_PARENTS), [object(`${SEVERAL_PARENTS}/object`, { 'pcdm:memberOf': [{ '@id': SEVERAL_PARENTS }, { '@id': OTHER }] })]),
  crate(collection(LARGE, { hasPart: [...LARGE_TEXTS, ...LARGE_AUDIO] }), [
    ...LARGE_TEXTS.map((path) => file(path, { content: 'words '.repeat(160_000), encodingFormat: 'text/plain' })),
    ...LARGE_AUDIO.map((path) => fileDescribedButNotHeld(path, { encodingFormat: 'audio/wav' })),
    fileDescribedButNotHeld('https://example.org/media/outside.wav'),
  ]),
  crate(collection(LONG_TEXT, { hasPart: ['long.txt'] }), [file('long.txt', { content: FIVE_MB, encodingFormat: 'text/plain' })]),
  crate(collection(UNREADABLE, { hasPart: ['unreadable.txt'] }), [file('unreadable.txt', { content: 'Gone', encodingFormat: 'text/plain' })]),
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

const found = async (query: string) => (await testbed.search({ query })).entities.map(({ id }: { id: string }) => id);

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

  it('gives a file the crate holds its size and place in the repository', async () => {
    await index(ROOT);

    const held = await testbed.started.prisma.file.findUniqueOrThrow({ where: { id: `${ROOT}/held.txt` } });
    expect([held.size, held.meta]).toEqual([9n, { ocflObject: ROOT, ocflPath: 'held.txt' }]);
  });

  it('indexes a file the crate describes but doesn’t hold with no place in the repository, warning once for the crate', async () => {
    await index(ROOT);

    const missing = await testbed.started.prisma.file.findUniqueOrThrow({ where: { id: `${ROOT}/missing.txt` } });
    expect([missing.size, missing.meta]).toEqual([0n, {}]);
    expect(logs.filter(({ msg }) => msg === 'Files described but not held')).toEqual([expect.objectContaining({ level: 40, crateId: ROOT, count: 1 })]);
  });

  it('makes only the first 1 MB of a text file searchable, logging the cut', async () => {
    await index(LONG_TEXT);

    expect(await found('early')).toEqual([`${LONG_TEXT}/long.txt`]);
    expect(await found('within')).toEqual([`${LONG_TEXT}/long.txt`]);
    expect(await found('beyond')).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ level: 40, crateId: LONG_TEXT, path: 'long.txt', size: 5_000_000, msg: 'File text cut short' }));
  });

  it('fails for a crate holding a file whose bytes can’t be read', async () => {
    const root = testbed.started.config.ocfl.root;
    for await (const path of glob('**/content/unreadable.txt', { cwd: root })) {
      await rm(join(root, path));
    }

    await index(UNREADABLE);

    expect(await state(UNREADABLE)).toMatchObject({ state: 'failed', error: expect.stringContaining('ENOENT') });
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

  it('writes every row and document of a crate larger than one batch', async () => {
    await index(LARGE);

    expect(await state(LARGE)).toMatchObject({ state: 'indexed', entities: 2108, files: 2107 });
    expect((await testbed.search({ query: '', limit: 1 })).total).toBe(2108);
    expect((await testbed.search({ query: 'words', limit: 10 })).total).toBe(LARGE_TEXTS.length);
  });

  it('logs a warning for each entity with several candidate parents', async () => {
    await index(SEVERAL_PARENTS);

    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 40,
        crateId: SEVERAL_PARENTS,
        entityId: `${SEVERAL_PARENTS}/object`,
        msg: 'Several candidate parents; using the first',
      }),
    );
  });

  it('indexes a crate with nothing to index', async () => {
    await index(UNPROFILED);

    expect(await state(UNPROFILED)).toMatchObject({ name: 'Unprofiled', state: 'indexed', entities: 0, files: 0 });
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
    await prisma.indexWorker.create({ data: { id: 'elsewhere' } });
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
    await testbed.started.prisma.indexWorker.create({ data: { id: 'elsewhere' } });
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
