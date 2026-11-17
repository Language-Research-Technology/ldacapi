import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OcflError, type StorageRoot, type VersionDetails } from '@ocfl/ocfl-fs';
import { ROCrate } from 'ro-crate';
import type { IndexQueue, Summary } from './index-queue/index-queue.ts';
import { logger } from './logger.ts';

/** How to index what is imported: the queue to ask, and how to run what `ask` asks for until finished, summarising it */
type Indexing = { indexQueue: IndexQueue; run: (ask: () => Promise<string[]>) => Promise<Summary> };

/** Merges the crate at `path` into its OCFL object, creating the object on first import */
async function importCrate(repository: StorageRoot, crateId: string, path: string) {
  const details: VersionDetails = {
    message: `Imported from ${path}`,
    user: { name: 'ldacapi crates:import', address: 'https://github.com/Language-Research-Technology/ldacapi' },
  };
  try {
    return await repository.create(crateId, details, (draft) => draft.import(path));
  } catch (error) {
    if (!(error instanceof OcflError && error.code === 'OBJECT_EXISTS')) {
      throw error;
    }
  }
  const object = await repository.open(crateId);
  return object.update(details, (draft) => draft.import(path));
}

/**
 * Imports each crate directory under `source` into the repository and, with `indexing`, asks to index each crate it writes
 * then runs those jobs until finished; false when any crate could not be imported or indexed
 */
export async function importCrates(repository: StorageRoot, source: string, indexing?: Indexing): Promise<boolean> {
  let imported = true;
  const importAll = async () => {
    const written: string[] = [];
    for (const directory of (await readdir(source, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
      const path = join(source, directory.name);
      const crate = await ROCrate.create(JSON.parse(await readFile(join(path, 'ro-crate-metadata.json'), 'utf-8')));
      try {
        const object = await importCrate(repository, crate.rootId, path);
        logger.info({ crateId: crate.rootId, path, version: object.head.number }, 'Imported crate');
        written.push(crate.rootId);
        await indexing?.indexQueue.index(crate.rootId);
      } catch (error) {
        // A crate another writer holds, or one that needs recovery, is left for a person; the rest still import
        const lockedAt = error instanceof OcflError ? error.lockedAt : undefined;
        logger.error({ err: error, crateId: crate.rootId, path, lockedAt }, 'Cannot import crate');
        imported = false;
      }
    }
    return written;
  };
  if (!indexing) {
    await importAll();
    return imported;
  }
  const { failed } = await indexing.run(importAll);
  return imported && failed.length === 0;
}
