import { cp, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorageRoot } from '@ocfl/ocfl-fs';
import { Client } from '@opensearch-project/opensearch';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collection, crate, writeCrates } from '../test/crate-builder.ts';
import { config } from './configuration.ts';
import { importCrates as importInto } from './crates-import.ts';
import { createIndexQueue } from './index-queue/index-queue.ts';
import { indexerDeps } from './indexer/deps.ts';
import { indexAndSummarise } from './indexer/index-run.ts';
import { prisma } from './prisma.ts';
import { openOrCreateRepository } from './repository/repository.ts';

const BUNDLED = 'arcp://name,bundled';

describe('crates:import', () => {
  let storage: string;
  let source: string;
  const root = () => join(storage, 'ocfl');
  const importCrates = async () => importInto(await openOrCreateRepository(root()), source);
  const head = async (id: string) => (await (await openStorageRoot(root())).open(id)).head;

  beforeEach(async () => {
    storage = await mkdtemp(join(tmpdir(), 'ldacapi-'));
    source = join(storage, 'crates');
    await cp('test-data', source, { recursive: true });
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

  it('adds no version when a crate is imported again unchanged', async () => {
    await importCrates();

    await importCrates();

    expect((await head(BUNDLED)).number).toBe(1);
  });

  it('merges a changed crate into a new version, keeping files it no longer has', async () => {
    await importCrates();
    const before = [...(await head(BUNDLED)).files.keys()];
    await writeFile(join(source, 'bundled', 'notes.txt'), 'added');
    await unlink(join(source, 'bundled', 'facts.csv'));

    await importCrates();

    const after = await head(BUNDLED);
    expect(after.number).toBe(2);
    expect([...after.files.keys()].sort()).toEqual([...before, 'notes.txt'].sort());
  });

  describe('indexing what it imports', () => {
    const opensearch = new Client({ node: config.opensearchUrl });

    /** Imports `source` into the repository, asking for each crate it writes to be indexed, then runs those jobs */
    const importAndIndex = async () => {
      const repository = await openOrCreateRepository(root());
      const indexQueue = createIndexQueue({ prisma, repository });
      const run = (ask: () => Promise<string[]>) => indexAndSummarise(indexerDeps(repository, opensearch), indexQueue, ask);
      return { imported: await importInto(repository, source, { indexQueue, run }), indexQueue };
    };

    beforeEach(async () => {
      await prisma.$executeRaw`TRUNCATE index_job, crate, index_worker, aggregate, file, entity CASCADE`;
    });

    afterAll(async () => {
      await prisma.$executeRaw`TRUNCATE index_job, crate, index_worker, aggregate, file, entity CASCADE`;
      await Promise.all([prisma.$disconnect(), opensearch.close()]);
    });

    it('leaves each crate it imports indexed', async () => {
      const { imported, indexQueue } = await importAndIndex();

      expect(imported).toBe(true);
      expect(await indexQueue.crate(BUNDLED)).toMatchObject({ state: 'indexed', version: 1 });
      expect(await indexQueue.counts()).toMatchObject({ indexed: (await indexQueue.crates()).length });
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
