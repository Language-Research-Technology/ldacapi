import { crc32 } from 'node:zlib';
import type { OcflObject, OcflObjectFile } from '@ocfl/ocfl';
import ocfl from '@ocfl/ocfl-fs';
import type { Client } from '@opensearch-project/opensearch';
import type { StorageBackend } from 'arocapi';
import { OcflStorage } from 'arocapi/storage/ocfl';
import { type RawEntity, ROCrate } from 'ro-crate';
import { config } from './configuration.ts';
import { DatabaseIndexer } from './indexer/database.ts';
import { type CrateObject, type Indexer, parentCollection } from './indexer/indexer.ts';
import { createSearchBackend, SearchIndexer } from './indexer/search.ts';
import { logger } from './logger.ts';
import { type IndexState, State } from './repository.ts';

const log = logger.child({ module: 'ocfl' });

const { defaultLicense, defaultMetadataLicense } = config;

const stateCache: { [key: string]: { [key: string]: IndexState | undefined } } = {};
let INDEXER: { [key: string]: Indexer };
let repository: ReturnType<typeof ocfl.storage>;
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
  repository = createStorage();
  try {
    await repository.load();
    backend = await OcflStorage({ root: config.ocfl.root });
  } catch (e) {
    if (await repository.exists()) {
      throw e;
    }
    throw new Error(`Cannot load the OCFL repository at ${config.ocfl.root}. Run \`pnpm ocfl:init\` to create it.`, { cause: e });
  }
}

/** arocapi's storage backend over the repository */
export function storage() {
  return backend;
}

/** The OCFL repository, created empty if it doesn't exist yet */
export async function openOrCreateStorage() {
  const storage = createStorage();
  if (await storage.exists()) {
    await storage.load();
  } else {
    await storage.create();
  }
  return storage;
}

export function createStorage() {
  return ocfl.storage({
    root: config.ocfl.root,
    workspace: config.ocfl.scratch,
    ocflVersion: '1.1',
    fixityAlgorithms: ['crc32'],
    layout: {
      extensionName: '000N-path-direct-storage-layout',
    },
  });
}

async function calculateCrc32(file: OcflObjectFile) {
  let crc = 0;
  for await (const chunk of await file.stream()) {
    crc = crc32(chunk, crc);
  }
  return crc.toString(16).padStart(8, '0');
}

function wrap(ocflObject: OcflObject): CrateObject {
  const getInventoryFile = (path: string) => {
    const file = ocflObject.getFile({ logicalPath: path });
    if (!file) {
      throw new Error(`File not found in ocfl inventory: ${path}`);
    }
    return file;
  };
  return {
    id: ocflObject.id,
    root: ocflObject.root,
    async text(path: string) {
      return await getInventoryFile(path).text();
    },
    async file(path: string) {
      const file = getInventoryFile(path);
      return {
        size: Number(file.size ?? file.fixity?.size ?? (await file.stat()).size),
        crc32: file.fixity?.crc32 ?? (await calculateCrc32(file)),
      };
    },
  };
}

function _setState(crateId: string, types: string | string[], state?: IndexState) {
  stateCache[crateId] = stateCache[crateId] || {};
  for (const type of ([] as string[]).concat(types)) {
    stateCache[crateId][type] = state;
  }
}

function setState(crateId: string | undefined, types: string | string[], state?: IndexState) {
  if (crateId) {
    _setState(crateId, types, state);
  } else {
    for (const id in stateCache) {
      _setState(id, types, state);
    }
  }
}

export async function getState(crateId: string, type?: string) {
  const indexers: [string, Indexer | undefined][] = type ? [[type, INDEXER[type]]] : Object.entries(INDEXER);
  for (const [name, indexer] of indexers) {
    if (!indexer) {
      return;
    }
    if (!stateCache[crateId]?.[name]) {
      const count = await indexer.count(crateId);
      if (count > 0) {
        stateCache[crateId] = stateCache[crateId] || {};
        stateCache[crateId][name] = State.INDEXED;
      }
    }
  }
  // A copy, as indexing goes on changing the cache after this returns
  return type ? { [type]: stateCache[crateId]?.[type] } : { ...stateCache[crateId] };
}

/**
 * The search index finds a crate's documents, and their rootCollection, by its database rows. So the rows are indexed
 * first and deleted last, deleting stops at the first failure, and deleting the rows deletes the documents too.
 */
const INDEX_ORDER = ['database', 'search'];
const DELETE_ORDER = ['search', 'database'];

const typesOf = (type?: string | string[]) => (type ? [type].flat() : INDEX_ORDER);

const withDocuments = (types: string[]) => (types.includes('database') && !types.includes('search') ? [...types, 'search'] : types);

async function deleteFrom(types: string[], crateId?: string) {
  for (const t of DELETE_ORDER.filter((t) => types.includes(t))) {
    try {
      await INDEXER[t]?.delete(crateId);
    } catch (error) {
      log.error({ err: error, crateId, indexer: t }, 'Error deleting index');
      throw error;
    }
  }
}

const readCrateJson = async (ocflObject: OcflObject): Promise<{ '@graph': RawEntity[] }> =>
  JSON.parse(await ocflObject.getFile({ logicalPath: 'ro-crate-metadata.json' }).text());

/** A crate's OCFL object, whose id is the crate's root id */
async function loadObject(crateId: string) {
  const ocflObject = repository.object(crateId);
  await ocflObject.load();
  return ocflObject;
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
          const root = json['@graph'].find((e) => e['@id'] === crateId);
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
        break;
      }
    }
    return top;
  };
}

async function indexObject(crateId: string, types: string[], findTopCollection: ReturnType<typeof topCollectionFinder>, force?: boolean) {
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
      const indexer = INDEXER[t];
      if (indexer) {
        setState(ocflObject.id, t, State.INDEXING);
        try {
          await indexer.index({ crateObject: wrap(ocflObject), crate, topCollection });
        } catch (error) {
          log.error({ err: error, crateId: ocflObject.id, indexer: t }, 'Error indexing object');
        } finally {
          setState(ocflObject.id, t);
        }
      }
    }
  } catch (error) {
    setState(crateId, types);
    log.error({ err: error, crateId }, 'Error reading object');
  }
}

async function idsMatching(pattern?: RegExp) {
  const ids: string[] = [];
  for await (const ocflObject of repository) {
    await ocflObject.load();
    if (!pattern || ocflObject.id.match(pattern)) {
      ids.push(ocflObject.id);
    }
  }
  return ids;
}

/** Indexes `crateIds`, the crates matching it, or every crate, marking them all queued before indexing any */
export async function createIndex(crateIds?: string | string[] | RegExp, type?: string | string[], force?: boolean) {
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

export async function deleteIndex(crateId?: string, type?: string | string[]) {
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
  for await (const ocflObject of repository) {
    try {
      const inv = await ocflObject.getInventory();
      const name = (await readCrateJson(ocflObject))['@graph'].find((e) => e['@id'] === inv.id)?.name?.toString();
      yield { id: inv.id, name, path: ocflObject.root, state: await getState(inv.id) };
    } catch (error) {
      log.error({ err: error, path: ocflObject.root }, 'Error reading object');
    }
  }
}
