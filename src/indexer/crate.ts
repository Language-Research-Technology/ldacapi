import type { OcflObject, StorageRoot } from '@ocfl/ocfl-fs';
import { type RawEntity, ROCrate } from 'ro-crate';
import { logger } from '../logger.ts';
import { type CrateObject, parentCollection } from './writer.ts';

const log = logger.child({ module: 'indexer/crate' });

type CrateJson = { '@graph': RawEntity[] };

const readCrateJson = async (object: OcflObject): Promise<CrateJson> => {
  const file = object.head.files.get('ro-crate-metadata.json');
  if (!file) {
    throw new Error(`No ro-crate-metadata.json in ${object.id}`);
  }
  return JSON.parse(await file.text());
};

const crateObject = (object: OcflObject): CrateObject => {
  const fileAt = (path: string) => {
    const file = object.head.files.get(path);
    if (!file) {
      throw new Error(`File not found in ocfl inventory: ${path}`);
    }
    return file;
  };
  return {
    id: object.id,
    text: (path) => fileAt(path).text(),
    file: async (path) => ({ size: await fileAt(path).size() }),
  };
};

/** The collection the crate `crateId` is a member of, read from the repository */
const parentOf = async (repository: StorageRoot, crateId: string) => {
  const parent = await ROCrate.create(await readCrateJson(await repository.open(crateId)));
  return parentCollection(parent.root, crateId);
};

/**
 * The top-level collection a crate sits under, found by following memberOf up through the parent crates in the repository,
 * so it doesn't depend on which crates are indexed yet
 */
async function topCollection(repository: StorageRoot, crate: ROCrate) {
  let top = crate.rootId;
  let parent = parentCollection(crate.root, crate.rootId);
  const seen = new Set([top]);
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    try {
      const next = await parentOf(repository, parent);
      top = parent;
      parent = next;
    } catch (error) {
      log.warn({ err: error, crateId: crate.rootId, parent, topCollection: top }, 'Cannot read parent collection; using the highest found');
      return top;
    }
  }
  if (parent) {
    log.warn({ crateId: crate.rootId, cycle: [...seen, parent], topCollection: top }, 'Collections are members of each other; using the highest found');
  }
  return top;
}

/** The crate `crateId` at its head version in the repository */
export async function openCrate(repository: StorageRoot, crateId: string) {
  const object = await repository.open(crateId);
  return {
    version: object.head.number,
    /** Reads and parses the crate's metadata */
    async read() {
      const crate = await ROCrate.create(await readCrateJson(object));
      return { crate, crateObject: crateObject(object), topCollection: await topCollection(repository, crate) };
    },
  };
}
