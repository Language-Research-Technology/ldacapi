import { chmod, cp, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openStorageRoot } from '@ocfl/ocfl-fs';
import { Client } from '@opensearch-project/opensearch';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/configuration.ts';
import { type ImportMode, importCrates as importInto, importMode } from '../src/crates-import.ts';
import { countStates, createIndexQueue } from '../src/index-queue/index-queue.ts';
import { indexerDeps } from '../src/indexer/deps.ts';
import { indexAndSummarise } from '../src/indexer/index-and-summarise.ts';
import { prisma } from '../src/prisma.ts';
import { openOrCreateRepository } from '../src/repository/repository.ts';
import { emptyEverything } from './app.ts';
import { collection, crate, file, object as objectEntity, writeCrateAt, writeCrates } from './crate-builder.ts';

const logs = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('../src/logger.ts', async () => (await import('./logs.ts')).capturingLogger(logs, 'info'));

const BUNDLED = 'arcp://name,bundled';
const INFO = 30;
const WARN = 40;
const ERROR = 50;

/** The records logged with `msg`, by path */
const logged = (msg: string) => logs.filter((record) => record.msg === msg).sort((a, b) => String(a.path).localeCompare(String(b.path)));

describe('importMode', () => {
  it.each([
    ['sync', 'sync'],
    ['add', 'add'],
    ['merge', undefined],
    [undefined, undefined],
  ])('reads %s as %s', (value, mode) => {
    expect(importMode(value)).toBe(mode);
  });
});

describe('crates:import', () => {
  let storage: string;
  let source: string;
  const root = () => join(storage, 'ocfl');
  const importCrates = async (mode: ImportMode = 'add', from = source, heartbeatMilliseconds?: number) =>
    importInto(await openOrCreateRepository(root()), from, { mode, heartbeatMilliseconds });
  const object = async (id: string) => (await openStorageRoot(root())).open(id);
  const head = async (id: string) => (await object(id)).head;
  /** The paths of the files a crate's head version holds, sorted */
  const files = async (id: string) => [...(await head(id)).files.keys()].sort();
  /** Adds a `malformed` crate folder whose metadata isn't JSON */
  const writeMalformedCrate = async () => {
    await mkdir(join(source, 'malformed'));
    await writeFile(join(source, 'malformed', 'ro-crate-metadata.json'), '{ not json');
  };
  /** Whether the import left out `id` and wrote another of the crates beside it */
  const importedAllBut = async (id: string) => {
    const repository = await openStorageRoot(root());
    return !(await repository.has(id)) && (await repository.has('arcp://name,distributed_root'));
  };

  beforeEach(async () => {
    storage = await mkdtemp(join(tmpdir(), 'ldacapi-'));
    source = join(storage, 'crates');
    await cp('test-data', source, { recursive: true });
    logs.length = 0;
  });

  afterEach(async () => {
    await rm(storage, { recursive: true, force: true });
  });

  it('records who imported each crate, and from where', async () => {
    await importCrates();

    expect(await head(BUNDLED)).toMatchObject({
      number: 1,
      message: `Imported from ${join(source, 'bundled')}`,
      user: { name: 'ldacapi crates:import', address: 'https://github.com/Language-Research-Technology/ldacapi' },
    });
  });

  describe('progress', () => {
    it('logs how many crates it found', async () => {
      await importCrates();

      expect(logged('Found crates')).toEqual([expect.objectContaining({ level: INFO, source, crates: 5, milliseconds: expect.any(Number) })]);
    });

    it("logs how many crates' metadata it read, and how many it could not", async () => {
      await writeMalformedCrate();

      await importCrates();

      expect(logged('Read crate metadata')).toEqual([expect.objectContaining({ level: INFO, readable: 5, unreadable: 1 })]);
    });

    it('logs when each crate starts, with its place among those it writes', async () => {
      await importCrates();

      expect(logged('Importing crate').map(({ level, position, total, path }) => [level, position, total, path])).toEqual(
        ['bundled', 'distributed_content_restricted', 'distributed_metadata_restricted', 'distributed_root', 'people'].map((folder, index) => [
          INFO,
          index + 1,
          5,
          join(source, folder),
        ]),
      );
      expect(logged('Importing crate')[0]).toMatchObject({ crateId: BUNDLED });
    });

    /** What the last import logged when it finished `crateId` */
    const finished = (crateId: string) => logs.filter((record) => record.crateId === crateId && record.msg === 'Imported crate');

    it('logs a crate it writes for the first time as written, with its version, files and time taken', async () => {
      await importCrates();

      expect(finished(BUNDLED)).toEqual([
        expect.objectContaining({ level: INFO, outcome: 'written', path: join(source, 'bundled'), version: 1, files: 7, milliseconds: expect.any(Number) }),
      ]);
    });

    it.each(['add', 'sync'] as const)('logs a crate imported again with changes as written, with its new version, in %s mode', async (mode) => {
      await importCrates(mode);
      await writeFile(join(source, 'bundled', 'notes.txt'), 'added');
      logs.length = 0;

      await importCrates(mode);

      expect(finished(BUNDLED)).toEqual([expect.objectContaining({ outcome: 'written', version: 2, files: 8 })]);
    });

    it.each(['add', 'sync'] as const)('logs a crate imported again unchanged as unchanged, in %s mode', async (mode) => {
      await importCrates(mode);
      logs.length = 0;

      await importCrates(mode);

      expect(finished(BUNDLED)).toEqual([
        expect.objectContaining({ level: INFO, outcome: 'unchanged', path: join(source, 'bundled'), version: 1, files: 7, milliseconds: expect.any(Number) }),
      ]);
    });
  });

  describe('heartbeats', () => {
    const FINDING = 'Still finding crates';
    const COPYING = 'Still importing crate';
    const beats = () => logs.filter(({ msg }) => msg === FINDING || msg === COPYING);

    // Enough entries for each stage to outlast a 1ms heartbeat
    const manyFolders = () => Promise.all(Array.from({ length: 300 }, (_, index) => mkdir(join(source, 'many', `folder-${index}`), { recursive: true })));
    const manyFiles = () => Promise.all(Array.from({ length: 300 }, (_, index) => writeFile(join(source, 'bundled', `file-${index}.txt`), `${index}`)));

    it('logs while it finds crates, with the folders listed and crates found so far', async () => {
      await manyFolders();

      await importCrates('add', source, 1);

      expect(logged(FINDING).length).toBeGreaterThan(0);
      expect(logged(FINDING)).toEqual(
        logged(FINDING).map(() => expect.objectContaining({ level: INFO, source, folders: expect.any(Number), crates: expect.any(Number) })),
      );
    });

    it('logs while a crate imports, with the files it has processed of its total', async () => {
      await manyFiles();

      await importCrates('add', source, 1);

      const copying = logs.filter(({ msg, crateId }) => msg === COPYING && crateId === BUNDLED);
      expect(copying.length).toBeGreaterThan(0);
      expect(copying).toEqual(
        copying.map(() =>
          expect.objectContaining({ level: INFO, path: join(source, 'bundled'), importedFiles: expect.any(Number), totalFiles: expect.any(Number) }),
        ),
      );
    });

    it('logs no heartbeat when each stage finishes within the interval', async () => {
      await importCrates();

      expect(beats()).toEqual([]);
    });

    it('stops each heartbeat when its stage ends, even when the crate fails', async () => {
      await Promise.all([manyFolders(), manyFiles()]);
      await chmod(join(source, 'bundled', 'data.txt'), 0o000);

      expect(await importCrates('add', source, 1)).toBe(false);
      const after = beats().length;
      await sleep(20);

      expect(beats().length).toBe(after);
      const messages = logs.map(({ msg }) => msg);
      expect(messages.lastIndexOf(FINDING)).toBeLessThan(messages.indexOf('Found crates'));
      expect(logs.findLastIndex(({ msg, crateId }) => msg === COPYING && crateId === BUNDLED)).toBeLessThan(
        logs.findIndex(({ msg, crateId }) => msg === 'Cannot import crate' && crateId === BUNDLED),
      );
    });
  });

  describe('summary', () => {
    const summary = () => logged('Import finished');

    it('counts the crates found and written, and the files they hold', async () => {
      await importCrates();

      expect(summary()).toEqual([
        expect.objectContaining({ level: INFO, source, found: 5, written: 5, unchanged: 0, failed: 0, files: 14, milliseconds: expect.any(Number) }),
      ]);
    });

    it('counts crates imported again unchanged', async () => {
      await importCrates('sync');
      logs.length = 0;

      await importCrates('sync');

      expect(summary()).toEqual([expect.objectContaining({ found: 5, written: 0, unchanged: 5, failed: 0, files: 14 })]);
    });

    it('counts each crate it could not read or write once, leaving their files out', async () => {
      await writeMalformedCrate();
      await cp(join(source, 'people'), join(source, 'people-copy'), { recursive: true });
      await chmod(join(source, 'bundled', 'data.txt'), 0o000);

      expect(await importCrates()).toBe(false);

      expect(summary()).toEqual([expect.objectContaining({ found: 7, written: 3, unchanged: 0, failed: 4, files: 6 })]);
    });

    it('logs a summary of nothing when it finds no crates', async () => {
      await rm(source, { recursive: true });
      await mkdir(source);

      await importCrates();

      expect(summary()).toEqual([expect.objectContaining({ found: 0, written: 0, unchanged: 0, failed: 0, files: 0 })]);
    });
  });

  describe('when a crate changes', () => {
    let before: string[];

    beforeEach(async () => {
      await importCrates();
      before = await files(BUNDLED);
      await writeFile(join(source, 'bundled', 'notes.txt'), 'added');
      await unlink(join(source, 'bundled', 'facts.csv'));
    });

    it('adds a new version keeping files it no longer has, in add mode', async () => {
      await importCrates('add');

      expect((await head(BUNDLED)).number).toBe(2);
      expect(await files(BUNDLED)).toEqual([...before, 'notes.txt'].sort());
    });

    it('adds a new version holding exactly what its folder holds, in sync mode, keeping earlier versions', async () => {
      await importCrates('sync');

      expect((await head(BUNDLED)).number).toBe(2);
      expect(await files(BUNDLED)).toEqual([...before.filter((path) => path !== 'facts.csv'), 'notes.txt'].sort());
      expect((await object(BUNDLED)).version(1).files.has('facts.csv')).toBe(true);
    });
  });

  it.each(['add', 'sync'] as const)('adds no version when a crate is imported again unchanged, in %s mode', async (mode) => {
    await importCrates(mode);

    await importCrates(mode);

    expect((await head(BUNDLED)).number).toBe(1);
  });

  describe("crates in other crates' folders", () => {
    const COLL = 'arcp://name,coll';
    const ITEM = 'arcp://name,item1';

    beforeEach(async () => {
      await rm(source, { recursive: true });
      await writeCrateAt(
        join(source, 'coll'),
        crate(collection(COLL), [file('intro.txt', { content: 'intro' }), file('batch/notes.txt', { content: 'notes' })]),
      );
      await writeCrateAt(join(source, 'coll', 'batch', 'item1'), crate(objectEntity(ITEM, { memberOf: COLL }), [file('data.txt', { content: 'data' })]));
    });

    it('imports each as its own crate, leaving it out of the crate above', async () => {
      expect(await importCrates()).toBe(true);

      expect(await files(COLL)).toEqual(['batch/notes.txt', 'intro.txt', 'ro-crate-metadata.json']);
      expect(await files(ITEM)).toEqual(['data.txt', 'ro-crate-metadata.json']);
    });

    it('imports the folder it is given as a crate, when it holds crate metadata', async () => {
      expect(await importCrates('add', join(source, 'coll'))).toBe(true);

      expect(await files(COLL)).toEqual(['batch/notes.txt', 'intro.txt', 'ro-crate-metadata.json']);
      expect(await files(ITEM)).toEqual(['data.txt', 'ro-crate-metadata.json']);
    });
  });

  describe('hidden entries', () => {
    beforeEach(async () => {
      await mkdir(join(source, 'bundled', '.git'));
      await writeFile(join(source, 'bundled', '.git', 'HEAD'), 'ref');
      await writeFile(join(source, 'bundled', '.DS_Store'), 'junk');
      await writeCrateAt(join(source, '.hidden'), crate(collection('arcp://name,hidden')));
      await writeFile(join(source, '._junk'), 'junk');
    });

    it('leaves them out, between crates and inside them', async () => {
      expect(await importCrates()).toBe(true);

      expect((await files(BUNDLED)).filter((path) => path.includes('.git') || path.includes('.DS_Store'))).toEqual([]);
      expect(await (await openStorageRoot(root())).has('arcp://name,hidden')).toBe(false);
    });

    it('warns once about each, except OS clutter', async () => {
      await importCrates();

      expect(logged('Skipped hidden entry')).toEqual([
        expect.objectContaining({ level: WARN, path: join(source, '.hidden') }),
        expect.objectContaining({ level: WARN, path: join(source, 'bundled', '.git') }),
      ]);
    });
  });

  describe('symlinks', () => {
    beforeEach(async () => {
      await symlink('data.txt', join(source, 'bundled', 'link.txt'));
      await symlink(join(source, 'bundled'), join(source, 'linked'));
    });

    it('skips each with a warning, still importing the crate holding it', async () => {
      expect(await importCrates()).toBe(true);

      expect(await files(BUNDLED)).not.toContain('link.txt');
      expect(logged('Skipped symlink')).toEqual([
        expect.objectContaining({ level: WARN, path: join(source, 'bundled', 'link.txt') }),
        expect.objectContaining({ level: WARN, path: join(source, 'linked') }),
      ]);
    });
  });

  describe('folders that hold no crate', () => {
    it('warns once, about the highest folder whose contents hold no crate', async () => {
      await mkdir(join(source, 'empty', 'deep', 'deeper'), { recursive: true });
      await writeFile(join(source, 'empty', 'deep', 'deeper', 'stray.txt'), 'stray');
      await writeCrateAt(join(source, 'group', 'sub'), crate(collection('arcp://name,grouped')));

      expect(await importCrates()).toBe(true);

      expect(logged('Folder holds no crate')).toEqual([expect.objectContaining({ level: WARN, path: join(source, 'empty') })]);
    });

    it('warns when the folder it is given holds no crate at all', async () => {
      await rm(source, { recursive: true });
      await mkdir(source);

      expect(await importCrates()).toBe(true);

      expect(logged('No crates found')).toEqual([expect.objectContaining({ level: WARN, source })]);
    });
  });

  it('skips a crate whose metadata cannot be read, importing the rest, and fails', async () => {
    await writeMalformedCrate();
    await mkdir(join(source, 'rootless'));
    await writeFile(
      join(source, 'rootless', 'ro-crate-metadata.json'),
      JSON.stringify({
        '@context': 'https://w3id.org/ro/crate/1.1/context',
        '@graph': [{ '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': './' } }],
      }),
    );

    expect(await importCrates()).toBe(false);

    expect((await head(BUNDLED)).number).toBe(1);
    expect(logged('Cannot read crate metadata')).toEqual([
      expect.objectContaining({ level: ERROR, path: join(source, 'malformed') }),
      expect.objectContaining({ level: ERROR, path: join(source, 'rootless') }),
    ]);
  });

  it.each([
    ['no id of its own', './'],
    ['no scheme', 'dx.doi.org/10.25911/42ds-nh06'],
    ['a blank node', '_:b0'],
  ])('skips a crate whose root id is not an absolute IRI (%s), importing the rest, and fails', async (_, rootId) => {
    await writeCrateAt(join(source, 'unnamed'), crate(collection(rootId)));

    expect(await importCrates()).toBe(false);

    expect(await importedAllBut(rootId)).toBe(true);
    expect(logged('Crate root id is not an absolute IRI')).toEqual([expect.objectContaining({ level: ERROR, path: join(source, 'unnamed'), rootId })]);
  });

  it('names each crate with no id of its own, rather than calling them a shared root id', async () => {
    await writeCrateAt(join(source, 'unnamed-1'), crate(collection('./')));
    await writeCrateAt(join(source, 'unnamed-2'), crate(collection('./')));

    expect(await importCrates()).toBe(false);

    expect(logged('Crate root id is not an absolute IRI')).toEqual([
      expect.objectContaining({ path: join(source, 'unnamed-1'), rootId: './' }),
      expect.objectContaining({ path: join(source, 'unnamed-2'), rootId: './' }),
    ]);
    expect(logged('Crates share a root id')).toEqual([]);
  });

  it('imports neither of two crates with the same root id, naming both folders, and fails', async () => {
    await cp(join(source, 'bundled'), join(source, 'bundled-copy'), { recursive: true });

    expect(await importCrates()).toBe(false);

    expect(await importedAllBut(BUNDLED)).toBe(true);
    expect(logged('Crates share a root id')).toEqual([
      expect.objectContaining({ level: ERROR, crateId: BUNDLED, paths: [join(source, 'bundled'), join(source, 'bundled-copy')] }),
    ]);
  });

  it('skips a crate it cannot write, importing the rest, and fails', async () => {
    await chmod(join(source, 'bundled', 'data.txt'), 0o000);

    expect(await importCrates()).toBe(false);

    expect(await importedAllBut(BUNDLED)).toBe(true);
    expect(logged('Cannot import crate')).toEqual([expect.objectContaining({ level: ERROR, crateId: BUNDLED, path: join(source, 'bundled') })]);
  });

  it('skips a folder it cannot read, importing the rest, and fails', async () => {
    const locked = join(source, 'locked');
    await writeCrateAt(join(locked, 'inside'), crate(collection('arcp://name,locked')));
    await chmod(locked, 0o000);

    const imported = await importCrates();
    await chmod(locked, 0o755);

    expect(imported).toBe(false);

    expect((await head(BUNDLED)).number).toBe(1);
    expect(logged('Cannot read folder')).toEqual([expect.objectContaining({ level: ERROR, path: locked })]);
    expect(logged('Folder holds no crate')).toEqual([]);
    expect(logged('Import finished')).toEqual([expect.objectContaining({ failed: 0, unreadableFolders: 1 })]);
  });

  it('imports a crate again when its head is dated later than this clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60 * 60 * 1000 });
    try {
      await importCrates('sync');
    } finally {
      vi.useRealTimers();
    }
    await writeFile(join(source, 'bundled', 'notes.txt'), 'added');
    logs.length = 0;

    expect(await importCrates('sync')).toBe(true);

    expect((await head(BUNDLED)).number).toBe(2);
    expect(logs.filter(({ msg, crateId }) => msg === 'Imported crate' && crateId === 'arcp://name,people')).toEqual([
      expect.objectContaining({ outcome: 'unchanged' }),
    ]);
  });

  it('fails when the folder it is given does not exist', async () => {
    const missing = join(storage, 'missing');

    expect(await importCrates('add', missing)).toBe(false);

    expect(logged('Cannot read folder')).toEqual([expect.objectContaining({ level: ERROR, path: missing })]);
  });

  describe('indexing what it imports', () => {
    const opensearch = new Client({ node: config.opensearchUrl });

    /** Imports `source` into the repository, asking for each crate it writes to be indexed, then runs those jobs */
    const importAndIndex = async () => {
      const repository = await openOrCreateRepository(root());
      const indexQueue = createIndexQueue({ prisma, repository });
      const run = (ask: () => Promise<string[]>) => indexAndSummarise(indexerDeps(repository, opensearch), indexQueue, ask);
      return { imported: await importInto(repository, source, { mode: 'sync', indexing: { indexQueue, run } }), indexQueue };
    };

    beforeEach(async () => {
      await emptyEverything(prisma, opensearch);
    });

    afterAll(async () => {
      await emptyEverything(prisma, opensearch);
      await Promise.all([prisma.$disconnect(), opensearch.close()]);
    });

    it('leaves each crate it imports indexed', async () => {
      const { imported, indexQueue } = await importAndIndex();

      expect(imported).toBe(true);
      expect(await indexQueue.crate(BUNDLED)).toMatchObject({ state: 'indexed', version: 1 });
      expect(countStates(await indexQueue.crates())).toMatchObject({ indexed: (await indexQueue.crates()).length });
    });

    it("logs the import's summary before indexing's", async () => {
      await importAndIndex();

      expect(logs.map(({ msg }) => msg).filter((msg) => msg === 'Import finished' || msg === 'Indexing finished')).toEqual([
        'Import finished',
        'Indexing finished',
      ]);
    });

    it('fails when a crate it imports fails to index, once the rest are indexed', async () => {
      await rm(source, { recursive: true });
      await writeCrates(source, [crate(collection('arcp://name,no-licence', { licence: null })), crate(collection('arcp://name,licensed'))]);

      const { imported, indexQueue } = await importAndIndex();

      expect(imported).toBe(false);
      expect((await indexQueue.crates()).map(({ id, state }) => [id, state])).toEqual([
        ['arcp://name,licensed', 'indexed'],
        ['arcp://name,no-licence', 'failed'],
      ]);
    });
  });
});
