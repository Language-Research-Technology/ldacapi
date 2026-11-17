import { buffer } from 'node:stream/consumers';
import type { OcflFile, OcflObject, StorageRoot } from '@ocfl/ocfl-fs';
import { type RawEntity, ROCrate } from 'ro-crate';
import { logger } from '../logger.ts';
import { parentCollection } from './derive.ts';

const log = logger.child({ module: 'indexer/crate' });

/** The most of a file's text that is indexed: search can't highlight past 1,000,000 characters */
const TEXT_LIMIT = 1_000_000;

type CrateJson = { '@graph': RawEntity[] };

const readCrateJson = async (object: OcflObject): Promise<CrateJson> => {
  const file = object.head.files.get('ro-crate-metadata.json');
  if (!file) {
    throw new Error(`No ro-crate-metadata.json in ${object.id}`);
  }
  return JSON.parse(await file.text());
};

/** The collection the crate `crateId` is a member of, read from the repository */
const parentOf = async (repository: StorageRoot, crateId: string) =>
  parentCollection(await ROCrate.create(await readCrateJson(await repository.open(crateId))));

/**
 * The collections above a crate's root, nearest first, found by following memberOf up through the parent crates in the
 * repository, so they don't depend on which crates are indexed yet. The last is the crate's top collection
 */
async function parentCrates(repository: StorageRoot, crate: ROCrate) {
  const chain: string[] = [];
  let parent = parentCollection(crate);
  const seen = new Set([crate.rootId]);
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    try {
      const next = await parentOf(repository, parent);
      chain.push(parent);
      parent = next;
    } catch (error) {
      log.warn(
        { err: error, crateId: crate.rootId, parent, topCollection: chain.at(-1) ?? crate.rootId },
        'Cannot read parent collection; using the highest found',
      );
      return chain;
    }
  }
  if (parent) {
    log.warn(
      { crateId: crate.rootId, cycle: [...seen, parent], topCollection: chain.at(-1) },
      'Collections are members of each other; using the highest found',
    );
  }
  return chain;
}

/** The size of each file the object holds, by its path; a file that can't be read fails */
async function heldFiles(object: OcflObject) {
  const sizes = new Map<string, number>();
  for (const [path, file] of object.head.files) {
    sizes.set(path, await file.size());
  }
  return sizes;
}

/** Reads the text of a held file, up to `TEXT_LIMIT` bytes */
const textReader = (object: OcflObject, sizes: ReadonlyMap<string, number>) => async (path: string) => {
  const file = object.head.files.get(path) as OcflFile;
  const bytes = await buffer(await file.stream({ end: TEXT_LIMIT - 1 }));
  const size = sizes.get(path) as number;
  if (size > TEXT_LIMIT) {
    log.warn({ crateId: object.id, path, size }, 'File text cut short');
  }
  // Streaming leaves out a character the cut splits
  return new TextDecoder().decode(bytes, { stream: true });
};

export type ReadText = ReturnType<typeof textReader>;

/** The crate `crateId` at its head version in the repository */
export async function openCrate(repository: StorageRoot, crateId: string) {
  const object = await repository.open(crateId);
  return {
    version: object.head.number,
    /** Reads and parses the crate's metadata, and finds the files it holds */
    async read() {
      const crate = await ROCrate.create(await readCrateJson(object));
      const sizes = await heldFiles(object);
      return { crate, heldFiles: sizes, readText: textReader(object, sizes), parentCrates: await parentCrates(repository, crate) };
    },
  };
}
