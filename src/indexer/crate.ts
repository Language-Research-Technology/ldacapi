import { buffer } from 'node:stream/consumers';
import type { OcflFile, OcflObject, StorageRoot } from '@ocfl/ocfl-fs';
import { type RawEntity, ROCrate } from 'ro-crate';
import { logger } from '../logger.ts';
import { parentCollection } from './derive.ts';
import type { Progress } from './progress.ts';

const log = logger.child({ module: 'indexer/crate' });

/** The most of a file's text that is indexed: search can't highlight past 1,000,000 characters */
const TEXT_LIMIT = 1_000_000;

type CrateJson = { '@graph': RawEntity[] };

const METADATA = 'ro-crate-metadata.json';

const readCrateJson = async (object: OcflObject): Promise<CrateJson> => {
  const file = object.head.files.get(METADATA);
  if (!file) {
    throw new Error(`No ${METADATA} in ${object.id}`);
  }
  return JSON.parse(await file.text());
};

/**
 * Each crate's parent collection, by the digest of the metadata it was read from: ids only, so a worker keeps it while
 * it runs, and parses a parent crate's metadata once rather than once per child
 */
export class ParentCache {
  #known = new Map<string, { digest: string; parent: string | undefined }>();
  repository: StorageRoot;

  constructor(repository: StorageRoot) {
    this.repository = repository;
  }

  /** The collection the crate `crateId` is a member of, its metadata read again only when it has changed */
  async of(crateId: string) {
    const object = await this.repository.open(crateId);
    const known = this.#known.get(crateId);
    if (known && known.digest === object.head.files.get(METADATA)?.digest) {
      return known.parent;
    }
    return this.remember(object, await ROCrate.create(await readCrateJson(object)));
  }

  /** Remembers the parent collection of `crate`, read from `object`, and returns it */
  remember(object: OcflObject, crate: ROCrate) {
    const parent = parentCollection(crate);
    this.#known.set(object.id, { digest: (object.head.files.get(METADATA) as OcflFile).digest, parent });
    return parent;
  }
}

/**
 * The collections above a crate's root, nearest first, found by following memberOf up through the parent crates in the
 * repository, so they don't depend on which crates are indexed yet. The last is the crate's top collection
 */
async function parentCrates(parents: ParentCache, crate: ROCrate) {
  const chain: string[] = [];
  let parent = parentCollection(crate);
  const seen = new Set([crate.rootId]);
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    try {
      const next = await parents.of(parent);
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

/** Files whose size is read at once */
const CONCURRENT_READS = 32;

/** The size of each file the object holds, by its path; a file that can't be read fails, naming it */
async function heldFiles(object: OcflObject, progress: Progress) {
  const sizes = new Map<string, number>();
  const files = object.head.files.entries();
  const reader = async () => {
    for (const [path, file] of files) {
      progress.signal.throwIfAborted();
      sizes.set(
        path,
        await file.size().catch((error: unknown) => {
          progress.on = path;
          throw error;
        }),
      );
    }
  };
  await Promise.all(Array.from({ length: CONCURRENT_READS }, reader));
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
  log.debug({ crateId: object.id, path }, 'File text read');
  // Streaming leaves out a character the cut splits
  return new TextDecoder().decode(bytes, { stream: true });
};

export type ReadText = ReturnType<typeof textReader>;

/** The crate `crateId` at its head version in `repository` */
export async function openCrate(repository: StorageRoot, parents: ParentCache, crateId: string) {
  const object = await repository.open(crateId);
  return {
    version: object.head.number,
    /** Reads and parses the crate's metadata, and finds the files it holds */
    async read(progress: Progress) {
      const crate = await ROCrate.create(await readCrateJson(object));
      parents.remember(object, crate);
      const sizes = await heldFiles(object, progress);
      return { crate, heldFiles: sizes, readText: textReader(object, sizes), parentCrates: await parentCrates(parents, crate) };
    },
  };
}
