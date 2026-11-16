import type { OcflObject, StorageRoot } from '@ocfl/ocfl-fs';
import type { Client } from '@opensearch-project/opensearch';
import type { StorageBackend } from 'arocapi';
import { OcflStorage } from 'arocapi/storage/ocfl';
import { type RawEntity, ROCrate } from 'ro-crate';
import { config } from './configuration.ts';
import { DatabaseIndexer } from './indexer/database.ts';
import { type CrateObject, type Indexer, parentCollection } from './indexer/indexer.ts';
import { createSearchBackend, SearchIndexer } from './indexer/search.ts';
import { logger } from './logger.ts';
import { openRepository } from './ocfl-repository.ts';
import { INDEX_TYPES, type IndexState, type IndexStates, type IndexType, State } from './repository.ts';

const log = logger.child({ module: 'ocfl' });

const { defaultLicense, defaultMetadataLicense } = config;

const stateCache: Record<string, IndexStates> = {};
let INDEXER: Record<IndexType, Indexer>;
let repository: StorageRoot;
let backend: StorageBackend;

export async function init(opts: { opensearchClient: Client; search?: ReturnType<typeof createSearchBackend> }) {
  log.info('Initializing OCFL repository and indexers');
  INDEXER = {
    database: await DatabaseIndexer.create({
      defaultLicense,
      defaultMetadataLicense,
    }),
    search: await SearchIndexer.create({
      defaultLicense,
      defaultMetadataLicense,
      client: opts.opensearchClient,
      search: opts.search ?? createSearchBackend(opts.opensearchClient),
    }),
  };
  repository = await openRepository();
  backend = await OcflStorage({ root: config.ocfl.root });
}

/** arocapi's storage backend over the repository */
export function storage() {
  return backend;
}

function wrap(ocflObject: OcflObject): CrateObject {
  const fileAt = (path: string) => {
    const file = ocflObject.head.files.get(path);
    if (!file) {
      throw new Error(`File not found in ocfl inventory: ${path}`);
    }
    return file;
  };
  return {
    id: ocflObject.id,
    text: (path) => fileAt(path).text(),
    file: async (path) => ({ size: await fileAt(path).size() }),
  };
}

function _setState(crateId: string, types: IndexType | IndexType[], state?: IndexState) {
  stateCache[crateId] ??= {};
  for (const type of [types].flat()) {
    stateCache[crateId][type] = state;
  }
}

function setState(crateId: string | undefined, types: IndexType | IndexType[], state?: IndexState) {
  if (crateId) {
    _setState(crateId, types, state);
  } else {
    for (const id in stateCache) {
      _setState(id, types, state);
    }
  }
}

export async function getState(crateId: string, type?: IndexType): Promise<IndexStates> {
  for (const name of type ? [type] : INDEX_TYPES) {
    if (!stateCache[crateId]?.[name] && (await INDEXER[name].count(crateId)) > 0) {
      _setState(crateId, name, State.INDEXED);
    }
  }
  // A copy, as indexing goes on changing the cache after this returns
  return type ? { [type]: stateCache[crateId]?.[type] } : { ...stateCache[crateId] };
}

/**
 * The search index finds a crate's documents, and their rootCollection, by its database rows. So the rows are indexed
 * first and deleted last, deleting stops at the first failure, and deleting the rows deletes the documents too.
 */
const INDEX_ORDER: readonly IndexType[] = INDEX_TYPES;
const DELETE_ORDER: readonly IndexType[] = ['search', 'database'];

const typesOf = (type?: IndexType | IndexType[]) => (type ? [type].flat() : [...INDEX_ORDER]);

const withDocuments = (types: IndexType[]): IndexType[] => (types.includes('database') && !types.includes('search') ? [...types, 'search'] : types);

async function deleteFrom(types: IndexType[], crateId?: string) {
  for (const t of DELETE_ORDER.filter((t) => types.includes(t))) {
    try {
      await INDEXER[t].delete(crateId);
    } catch (error) {
      log.error({ err: error, crateId, indexer: t }, 'Error deleting index');
      throw error;
    }
  }
}

const readCrateJson = async (ocflObject: OcflObject): Promise<{ '@graph': RawEntity[] }> => {
  const file = ocflObject.head.files.get('ro-crate-metadata.json');
  if (!file) {
    throw new Error(`No ro-crate-metadata.json in ${ocflObject.id}`);
  }
  return JSON.parse(await file.text());
};

/** The root entity of a crate's raw JSON-LD, whose id is the OCFL object's */
const rawRoot = (json: { '@graph': RawEntity[] }, crateId: string) => json['@graph'].find((e) => e['@id'] === crateId);

/** A crate's OCFL object, whose id is the crate's root id */
const loadObject = (crateId: string) => repository.open(crateId);

/** Each crate's OCFL object, logging those that can't be read */
async function* readableObjects() {
  for await (const entry of repository.objects()) {
    if ('object' in entry) {
      yield entry.object;
    } else {
      log.error({ err: entry.error, objectRoot: entry.objectRoot, crateId: entry.id }, 'Error reading object');
    }
  }
}

/**
 * Finds the top-level collection a crate sits under by following memberOf up through the parent crates in the repository,
 * so it doesn't depend on which crates are indexed yet. Each crate's parent is cached for the life of the finder.
 */
function topCollectionFinder() {
  const parents = new Map<string, Promise<string | undefined>>();
  const parentOf = (crateId: string) => {
    let parent = parents.get(crateId);
    if (!parent) {
      parent = loadObject(crateId)
        .then(readCrateJson)
        .then((json) => {
          const root = rawRoot(json, crateId);
          return root && parentCollection(root, crateId);
        });
      parents.set(crateId, parent);
    }
    return parent;
  };
  return async (crate: ROCrate) => {
    let top = crate.rootId;
    let parent = parentCollection(crate.root, crate.rootId);
    if (!parents.has(top)) {
      parents.set(top, Promise.resolve(parent));
    }
    const seen = new Set([top]);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      try {
        const next = await parentOf(parent);
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
  };
}

async function indexObject(crateId: string, types: IndexType[], findTopCollection: ReturnType<typeof topCollectionFinder>, force?: boolean) {
  try {
    const ocflObject = await loadObject(crateId);
    const crate = await ROCrate.create(await readCrateJson(ocflObject));
    log.debug({ crateId: ocflObject.id }, 'Found OCFL object');
    if (force) {
      setState(ocflObject.id, types, State.INDEXING);
      try {
        await deleteFrom(types, crate.rootId);
      } catch {
        setState(ocflObject.id, types);
        return;
      }
    }
    const topCollection = await findTopCollection(crate);
    for (const t of INDEX_ORDER.filter((t) => types.includes(t))) {
      setState(ocflObject.id, t, State.INDEXING);
      try {
        await INDEXER[t].index({ crateObject: wrap(ocflObject), crate, topCollection });
      } catch (error) {
        log.error({ err: error, crateId: ocflObject.id, indexer: t }, 'Error indexing object');
      } finally {
        setState(ocflObject.id, t);
      }
    }
  } catch (error) {
    setState(crateId, types);
    log.error({ err: error, crateId }, 'Error reading object');
  }
}

async function idsMatching(pattern?: RegExp) {
  const ids: string[] = [];
  for await (const ocflObject of readableObjects()) {
    if (!pattern || ocflObject.id.match(pattern)) {
      ids.push(ocflObject.id);
    }
  }
  return ids;
}

/** Indexes `crateIds`, the crates matching it, or every crate, marking them all queued before indexing any */
export async function createIndex(crateIds?: string | string[] | RegExp, type?: IndexType | IndexType[], force?: boolean) {
  log.debug('Indexing started');
  const types = force ? withDocuments(typesOf(type)) : typesOf(type);
  // Given ids are queued before the first await, so callers see them in progress at once
  const ids = typeof crateIds === 'string' || Array.isArray(crateIds) ? [crateIds].flat() : await idsMatching(crateIds);
  for (const id of ids) {
    setState(id, types, State.QUEUED);
  }
  const findTopCollection = topCollectionFinder();
  for (const id of ids) {
    await indexObject(id, types, findTopCollection, force);
  }
  log.debug('Indexing finished');
}

export async function deleteIndex(crateId?: string, type?: IndexType | IndexType[]) {
  const types = withDocuments(typesOf(type));
  setState(crateId, types, State.DELETING);
  try {
    await deleteFrom(types, crateId);
  } finally {
    setState(crateId, types);
  }
}

export async function* objects(prefix?: string, refresh?: boolean) {
  if (typeof prefix === 'boolean') {
    refresh = prefix;
    prefix = '';
  } else if (prefix == null) {
    prefix = '';
  }
  for await (const ocflObject of readableObjects()) {
    const { id } = ocflObject;
    try {
      const name = rawRoot(await readCrateJson(ocflObject), id)?.name?.toString();
      yield { id, name, state: await getState(id) };
    } catch (error) {
      log.error({ err: error, crateId: id }, 'Error reading object');
    }
  }
}
