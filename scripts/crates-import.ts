import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OcflError, type StorageRoot, type VersionDetails } from '@ocfl/ocfl-fs';
import { ROCrate } from 'ro-crate';
import { config } from '../src/configuration.ts';
import { logger } from '../src/logger.ts';
import { openOrCreateRepository } from '../src/ocfl-repository.ts';

const source = resolve(process.argv[2] ?? 'test-data');

/** Merges the crate at `path` into its OCFL object, creating the object on first import */
async function importCrate(repository: StorageRoot, crateId: string, path: string) {
  const details: VersionDetails = { message: `Imported from ${path}`, user: { name: 'ldacapi crates:import' } };
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

const repository = await openOrCreateRepository();

const directories = await readdir(source, { withFileTypes: true });
for (const directory of directories.filter((entry) => entry.isDirectory())) {
  const path = join(source, directory.name);
  const crate = await ROCrate.create(JSON.parse(await readFile(join(path, 'ro-crate-metadata.json'), 'utf-8')));
  try {
    const object = await importCrate(repository, crate.rootId, path);
    logger.info({ crateId: crate.rootId, path, version: object.head.number }, 'Imported crate');
  } catch (error) {
    // A crate another writer holds, or one that needs recovery, is left for a person; the rest still import
    const lockedAt = error instanceof OcflError ? error.lockedAt : undefined;
    logger.error({ err: error, crateId: crate.rootId, path, lockedAt }, 'Cannot import crate');
    process.exitCode = 1;
  }
}
logger.info({ root: config.ocfl.root }, 'Imported crates into the OCFL repository');
