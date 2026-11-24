import { chmod, cp, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

vi.mock('../src/logger.ts', async () => (await import('./logs.ts')).capturingLogger(logs, 'warn'));

const BUNDLED = 'arcp://name,bundled';
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
  const importCrates = async (mode: ImportMode = 'add', from = source) => importInto(await openOrCreateRepository(root()), from, { mode });
  const object = async (id: string) => (await openStorageRoot(root())).open(id);
  const head = async (id: string) => (await object(id)).head;
  /** The paths of the files a crate's head version holds, sorted */
  const files = async (id: string) => [...(await head(id)).files.keys()].sort();
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
    await mkdir(join(source, 'malformed'));
    await writeFile(join(source, 'malformed', 'ro-crate-metadata.json'), '{ not json');
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
