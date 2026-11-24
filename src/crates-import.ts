import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StorageRoot } from '@ocfl/ocfl-fs';
import { ROCrate } from 'ro-crate';
import type { IndexQueue, Summary } from './index-queue/index-queue.ts';
import { logger } from './logger.ts';

/** How to index what is imported: the queue to ask, and how to run what `ask` asks for until finished, summarising it */
type Indexing = { indexQueue: IndexQueue; run: (ask: () => Promise<string[]>) => Promise<Summary> };

/** `sync` makes each crate's new version hold exactly what its folder holds; `add` adds and replaces files, removing none */
const IMPORT_MODES = ['sync', 'add'] as const;

export type ImportMode = (typeof IMPORT_MODES)[number];

/** The import mode `value` names, if it names one */
export const importMode = (value: unknown) => IMPORT_MODES.find((mode) => mode === value);

type ImportOptions = { mode: ImportMode; indexing?: Indexing | undefined };

/** The ids of the crates written, and whether any could not be */
type Imported = { written: string[]; failed: boolean };

/** A crate's folder, and the folders of the nearest crates below it, relative to it */
type CrateFolder = { folder: string; nested: Set<string> };

const METADATA = 'ro-crate-metadata.json';

const OS_CLUTTER = new Set(['.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd']);

/** Why an entry is never imported or followed, if it isn't: it is hidden, OS clutter (hidden too), or a symlink */
const leftOutAs = (entry: Dirent) => {
  if (entry.name.startsWith('.')) {
    return OS_CLUTTER.has(entry.name) || entry.name.startsWith('._') ? 'clutter' : 'hidden';
  }
  return entry.isSymbolicLink() ? 'symlink' : undefined;
};

const WARNINGS = { hidden: 'Skipped hidden entry', symlink: 'Skipped symlink' } as const;

/**
 * Whether the walk leaves out the entry at `path`, warning when someone may have wanted it. The walk lists every folder a
 * crate's import does, so the import's filter leaves the same entries out without warning again
 */
const skipped = (entry: Dirent, path: string) => {
  const reason = leftOutAs(entry);
  if (reason === 'hidden' || reason === 'symlink') {
    logger.warn({ path }, WARNINGS[reason]);
  }
  return reason !== undefined;
};

/**
 * What a walk finds at or below a folder: its crates, each before the crates below it, whether the folder is one, and
 * whether a folder could not be read
 */
type Found = { crates: CrateFolder[]; isCrate: boolean; highest: string[]; failed: boolean };

/**
 * The crates at or below `directory` in name order, and, unless it is a crate, the folders of the highest of them,
 * relative to it. Outside crates, warns about each folder that leads to no crate when the folder above it does, so only
 * the highest of them is named
 */
async function findCrates(directory: string, inCrate = false): Promise<Found> {
  let listed: Dirent[];
  try {
    listed = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    logger.error({ err: error, path: directory }, 'Cannot read folder');
    return { crates: [], isCrate: false, highest: [], failed: true };
  }
  const entries = listed.filter((entry) => !skipped(entry, join(directory, entry.name)));
  const isCrate = entries.some((entry) => entry.isFile() && entry.name === METADATA);
  const crates: CrateFolder[] = [];
  const highest: string[] = [];
  const leadNowhere: string[] = [];
  let failed = false;
  // One folder at a time, so only the listings on the way down are held
  for (const name of entries.flatMap((entry) => (entry.isDirectory() ? [entry.name] : [])).sort()) {
    const below = await findCrates(join(directory, name), inCrate || isCrate);
    crates.push(...below.crates);
    highest.push(...(below.isCrate ? [name] : below.highest.map((folder) => `${name}/${folder}`)));
    failed ||= below.failed;
    if (below.crates.length === 0 && !below.failed) {
      leadNowhere.push(join(directory, name));
    }
  }
  if (isCrate) {
    return { crates: [{ folder: directory, nested: new Set(highest) }, ...crates], isCrate, highest: [], failed };
  }
  if (!inCrate && crates.length > 0) {
    for (const path of leadNowhere) {
      logger.warn({ path }, 'Folder holds no crate');
    }
  }
  return { crates, isCrate, highest, failed };
}

/** Writes the crate in `folder` into its OCFL object, creating the object on first import, leaving out the `nested` crates' folders */
const importCrate = (repository: StorageRoot, crateId: string, { folder, nested }: CrateFolder, mode: ImportMode) =>
  repository.createOrUpdate(
    crateId,
    { message: `Imported from ${folder}`, user: { name: 'ldacapi crates:import', address: 'https://github.com/Language-Research-Technology/ldacapi' } },
    async (draft) => {
      if (mode === 'sync') {
        await draft.clear();
      }
      await draft.import(folder, { filter: (relativePath, entry) => !nested.has(relativePath) && leftOutAs(entry) === undefined });
    },
  );

/** The root `@id` of the crate in `folder`, or undefined, logged, when its metadata can't be read */
async function readCrateId(folder: string): Promise<string | undefined> {
  try {
    return (await ROCrate.create(JSON.parse(await readFile(join(folder, METADATA), 'utf-8')))).rootId;
  } catch (error) {
    logger.error({ err: error, path: folder }, 'Cannot read crate metadata');
    return undefined;
  }
}

async function importAll(repository: StorageRoot, source: string, mode: ImportMode, indexQueue?: IndexQueue): Promise<Imported> {
  const { crates, failed } = await findCrates(source);
  const imported: Imported = { written: [], failed };
  if (crates.length === 0) {
    logger.warn({ source }, 'No crates found');
  }
  // Every crate is read before any is written, so a duplicate id is caught before either copy is; one at a time, as metadata can be large
  const readable: (CrateFolder & { crateId: string })[] = [];
  for (const crate of crates) {
    const crateId = await readCrateId(crate.folder);
    if (crateId) {
      readable.push({ ...crate, crateId });
    } else {
      imported.failed = true;
    }
  }
  for (const [crateId, claimants] of Map.groupBy(readable, (crate) => crate.crateId)) {
    if (claimants.length > 1) {
      logger.error({ crateId, paths: claimants.map(({ folder }) => folder) }, 'Crates share a root id');
      imported.failed = true;
      continue;
    }
    for (const crate of claimants) {
      try {
        const object = await importCrate(repository, crateId, crate, mode);
        logger.info({ crateId, path: crate.folder, version: object.head.number }, 'Imported crate');
        imported.written.push(crateId);
        await indexQueue?.index(crateId);
      } catch (error) {
        // A crate another writer holds, or one that needs recovery, is left for a person; the rest still import
        logger.error({ err: error, crateId, path: crate.folder }, 'Cannot import crate');
        imported.failed = true;
      }
    }
  }
  return imported;
}

/**
 * Imports each crate at or below `source` into the repository and, with `indexing`, asks to index each crate it writes
 * then runs those jobs until finished; false when any crate could not be imported or indexed
 */
export async function importCrates(repository: StorageRoot, source: string, { mode, indexing }: ImportOptions): Promise<boolean> {
  if (!indexing) {
    return !(await importAll(repository, source, mode)).failed;
  }
  let imported: Imported = { written: [], failed: false };
  const { failed } = await indexing.run(async () => {
    imported = await importAll(repository, source, mode, indexing.indexQueue);
    return imported.written;
  });
  return !imported.failed && failed.length === 0;
}
