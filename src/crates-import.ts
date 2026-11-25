import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImportProgress, StorageRoot } from '@ocfl/ocfl-fs';
import { ROCrate } from 'ro-crate';
import type { IndexQueue, Summary } from './index-queue/index-queue.ts';
import { logger } from './logger.ts';
import { isAbsoluteIri } from './repository/entity-id.ts';

/** How to index what is imported: the queue to ask, and how to run what `ask` asks for until finished, summarising it */
type Indexing = { indexQueue: IndexQueue; run: (ask: () => Promise<string[]>) => Promise<Summary> };

/** `sync` makes each crate's new version hold exactly what its folder holds; `add` adds and replaces files, removing none */
const IMPORT_MODES = ['sync', 'add'] as const;

export type ImportMode = (typeof IMPORT_MODES)[number];

/** The import mode `value` names, if it names one */
export const importMode = (value: unknown) => IMPORT_MODES.find((mode) => mode === value);

/** `heartbeatMilliseconds`: how often a long walk or crate import logs how far it has got */
type ImportOptions = { mode: ImportMode; indexing?: Indexing | undefined; heartbeatMilliseconds?: number | undefined };

const HEARTBEAT_MILLISECONDS = 30_000;

/** The ids of the crates imported, written or unchanged, and whether any could not be */
type Imported = { crateIds: string[]; failed: boolean };

/** A crate's folder, and the folders of the nearest crates below it, relative to it */
type CrateFolder = { folder: string; nested: Set<string> };

/** Whole milliseconds since `start`, a `performance.now()` */
const elapsed = (start: number) => Math.round(performance.now() - start);

/** Runs `stage`, logging `msg` with the fields `progress` gives every `milliseconds` until it settles */
async function withHeartbeat<T>(milliseconds: number, msg: string, progress: () => object, stage: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => logger.info(progress(), msg), milliseconds);
  timer.unref();
  try {
    return await stage();
  } finally {
    clearInterval(timer);
  }
}

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

/** How far a walk has got: the folders it has listed, the crates among them, and the folders it could not list */
type Walked = { folders: number; crates: number; unreadable: number };

/**
 * The crates at or below `directory` in name order, and, unless it is a crate, the folders of the highest of them,
 * relative to it, counting into `walked` as it goes. Outside crates, warns about each folder that leads to no crate when
 * the folder above it does, so only the highest of them is named
 */
async function findCrates(directory: string, walked: Walked, inCrate = false): Promise<Found> {
  let listed: Dirent[];
  try {
    listed = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    logger.error({ err: error, path: directory }, 'Cannot read folder');
    walked.unreadable += 1;
    return { crates: [], isCrate: false, highest: [], failed: true };
  }
  const entries = listed.filter((entry) => !skipped(entry, join(directory, entry.name)));
  const isCrate = entries.some((entry) => entry.isFile() && entry.name === METADATA);
  walked.folders += 1;
  walked.crates += isCrate ? 1 : 0;
  const crates: CrateFolder[] = [];
  const highest: string[] = [];
  const leadNowhere: string[] = [];
  let failed = false;
  // One folder at a time, so only the listings on the way down are held
  for (const name of entries.flatMap((entry) => (entry.isDirectory() ? [entry.name] : [])).sort()) {
    const below = await findCrates(join(directory, name), walked, inCrate || isCrate);
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

/**
 * Writes the crate in `folder` into its OCFL object, creating the object on first import, leaving out the `nested` crates'
 * folders, telling `onProgress` how far it has got. Returns the object, and whether a version was written or the crate
 * was unchanged
 */
async function importCrate(
  repository: StorageRoot,
  crateId: string,
  { folder, nested }: CrateFolder,
  mode: ImportMode,
  onProgress: (progress: ImportProgress) => void,
) {
  const before = Date.now();
  const object = await repository.createOrUpdate(
    crateId,
    { message: `Imported from ${folder}`, user: { name: 'ldacapi crates:import', address: 'https://github.com/Language-Research-Technology/ldacapi' } },
    async (draft) => {
      onProgress({ importedFiles: 0, totalFiles: 0 });
      if (mode === 'sync') {
        await draft.clear();
      }
      await draft.import(folder, { filter: (relativePath, entry) => !nested.has(relativePath) && leftOutAs(entry) === undefined, onProgress });
    },
  );
  // A committed version is dated during this call; an unchanged crate comes back at its old head, dated outside it
  const created = object.head.createdAt.getTime();
  return { object, outcome: before <= created && created <= Date.now() ? ('written' as const) : ('unchanged' as const) };
}

/** A crate whose root id has been read */
type IdentifiedCrate = CrateFolder & { crateId: string };

/** What became of a crate the import tried to write: written or unchanged, with the files its folder gave, or failed */
type Outcome = { outcome: 'written' | 'unchanged'; files: number } | { outcome: 'failed' };

/**
 * Imports one crate, the `position`th of `total`, logging when it starts, how far it has got every `heartbeatMilliseconds`,
 * and what became of it, then asks to index it
 */
async function writeCrate(
  repository: StorageRoot,
  crate: IdentifiedCrate,
  { mode, heartbeatMilliseconds, indexQueue }: { mode: ImportMode; heartbeatMilliseconds: number; indexQueue?: IndexQueue | undefined },
  place: { position: number; total: number },
): Promise<Outcome> {
  const { crateId, folder: path } = crate;
  logger.info({ crateId, path, ...place }, 'Importing crate');
  const started = performance.now();
  let progress: ImportProgress = { importedFiles: 0, totalFiles: 0 };
  try {
    const { object, outcome } = await withHeartbeat(
      heartbeatMilliseconds,
      'Still importing crate',
      () => ({ crateId, path, ...progress }),
      () =>
        importCrate(repository, crateId, crate, mode, (reached) => {
          progress = reached;
        }),
    );
    const files = progress.totalFiles;
    logger.info({ crateId, path, outcome, version: object.head.number, files, milliseconds: elapsed(started) }, 'Imported crate');
    await indexQueue?.index(crateId);
    return { outcome, files };
  } catch (error) {
    // A crate another writer holds, or one that needs recovery, is left for a person; the rest still import
    logger.error({ err: error, crateId, path }, 'Cannot import crate');
    return { outcome: 'failed' };
  }
}

/** The root `@id` of the crate in `folder`, or undefined, logged, when unreadable or not an absolute IRI */
async function readCrateId(folder: string): Promise<string | undefined> {
  let rootId: string;
  try {
    ({ rootId } = await ROCrate.create(JSON.parse(await readFile(join(folder, METADATA), 'utf-8'))));
  } catch (error) {
    logger.error({ err: error, path: folder }, 'Cannot read crate metadata');
    return undefined;
  }
  if (!isAbsoluteIri(rootId)) {
    logger.error({ path: folder, rootId }, 'Crate root id is not an absolute IRI');
    return undefined;
  }
  return rootId;
}

async function importAll(
  repository: StorageRoot,
  source: string,
  { mode, heartbeatMilliseconds = HEARTBEAT_MILLISECONDS }: Omit<ImportOptions, 'indexing'>,
  indexQueue?: IndexQueue,
): Promise<Imported> {
  const started = performance.now();
  const walked: Walked = { folders: 0, crates: 0, unreadable: 0 };
  const { crates } = await withHeartbeat(
    heartbeatMilliseconds,
    'Still finding crates',
    () => ({ source, ...walked }),
    () => findCrates(source, walked),
  );
  logger.info({ source, crates: crates.length, milliseconds: elapsed(started) }, 'Found crates');
  if (crates.length === 0) {
    logger.warn({ source }, 'No crates found');
  }
  const counts = { found: crates.length, written: 0, unchanged: 0, failed: 0, files: 0 };
  // Every crate is read before any is written, so a duplicate id is caught before either copy is; one at a time, as metadata can be large
  const readable: IdentifiedCrate[] = [];
  for (const crate of crates) {
    const crateId = await readCrateId(crate.folder);
    if (crateId) {
      readable.push({ ...crate, crateId });
    } else {
      counts.failed += 1;
    }
  }
  logger.info({ readable: readable.length, unreadable: counts.failed }, 'Read crate metadata');
  const toWrite: IdentifiedCrate[] = [];
  for (const [crateId, claimants] of Map.groupBy(readable, (crate) => crate.crateId)) {
    if (claimants.length > 1) {
      logger.error({ crateId, paths: claimants.map(({ folder }) => folder) }, 'Crates share a root id');
      counts.failed += claimants.length;
    } else {
      toWrite.push(...claimants);
    }
  }
  const crateIds: string[] = [];
  for (const [index, crate] of toWrite.entries()) {
    const result = await writeCrate(repository, crate, { mode, heartbeatMilliseconds, indexQueue }, { position: index + 1, total: toWrite.length });
    counts[result.outcome] += 1;
    if (result.outcome !== 'failed') {
      counts.files += result.files;
      crateIds.push(crate.crateId);
    }
  }
  logger.info({ source, ...counts, unreadableFolders: walked.unreadable, milliseconds: elapsed(started) }, 'Import finished');
  return { crateIds, failed: walked.unreadable > 0 || counts.failed > 0 };
}

/**
 * Imports each crate at or below `source` into the repository and, with `indexing`, asks to index each crate it writes
 * then runs those jobs until finished; false when any crate could not be imported or indexed
 */
export async function importCrates(repository: StorageRoot, source: string, { indexing, ...options }: ImportOptions): Promise<boolean> {
  if (!indexing) {
    return !(await importAll(repository, source, options)).failed;
  }
  let imported: Imported = { crateIds: [], failed: false };
  const { failed } = await indexing.run(async () => {
    imported = await importAll(repository, source, options, indexing.indexQueue);
    return imported.crateIds;
  });
  return !imported.failed && failed.length === 0;
}
