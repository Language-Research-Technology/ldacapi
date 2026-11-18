import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StorageRoot } from '@ocfl/ocfl-fs';
import { ROCrate } from 'ro-crate';
import type { IndexQueue, Summary } from './index-queue/index-queue.ts';
import { logger } from './logger.ts';

/** How to index what is imported: the queue to ask, and how to run what `ask` asks for until finished, summarising it */
type Indexing = { indexQueue: IndexQueue; run: (ask: () => Promise<string[]>) => Promise<Summary> };

/** The ids of the crates written, and whether any could not be */
type Imported = { written: string[]; failed: boolean };

/** Merges the crate at `path` into its OCFL object, creating the object on first import */
const importCrate = (repository: StorageRoot, crateId: string, path: string) =>
  repository.createOrUpdate(
    crateId,
    { message: `Imported from ${path}`, user: { name: 'ldacapi crates:import', address: 'https://github.com/Language-Research-Technology/ldacapi' } },
    (draft) => draft.import(path),
  );

async function importAll(repository: StorageRoot, source: string, indexQueue?: IndexQueue): Promise<Imported> {
  const imported: Imported = { written: [], failed: false };
  for (const directory of (await readdir(source, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
    const path = join(source, directory.name);
    const crate = await ROCrate.create(JSON.parse(await readFile(join(path, 'ro-crate-metadata.json'), 'utf-8')));
    try {
      const object = await importCrate(repository, crate.rootId, path);
      logger.info({ crateId: crate.rootId, path, version: object.head.number }, 'Imported crate');
      imported.written.push(crate.rootId);
      await indexQueue?.index(crate.rootId);
    } catch (error) {
      // A crate another writer holds, or one that needs recovery, is left for a person; the rest still import
      logger.error({ err: error, crateId: crate.rootId, path }, 'Cannot import crate');
      imported.failed = true;
    }
  }
  return imported;
}

/**
 * Imports each crate directory under `source` into the repository and, with `indexing`, asks to index each crate it writes
 * then runs those jobs until finished; false when any crate could not be imported or indexed
 */
export async function importCrates(repository: StorageRoot, source: string, indexing?: Indexing): Promise<boolean> {
  if (!indexing) {
    return !(await importAll(repository, source)).failed;
  }
  let imported: Imported = { written: [], failed: false };
  const { failed } = await indexing.run(async () => {
    imported = await importAll(repository, source, indexing.indexQueue);
    return imported.written;
  });
  return !imported.failed && failed.length === 0;
}
