import { crc32 } from 'node:zlib';
import type { OcflObject, OcflObjectFile } from '@ocfl/ocfl';
import ocfl from '@ocfl/ocfl-fs';
import type { Client } from '@opensearch-project/opensearch';
import type { StorageBackend } from 'arocapi';
import { OcflStorage } from 'arocapi/storage/ocfl';
import { type RawEntity, ROCrate } from 'ro-crate';
import { config } from './configuration.ts';
import type { CrateObject, Indexer } from './indexer/indexer.ts';
import { createSearchBackend, SearchIndexer } from './indexer/search.ts';
import { StructuralIndexer } from './indexer/structural.ts';
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
    structural: await StructuralIndexer.create({
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
    throw new Error(`Cannot load the OCFL repository at ${config.ocfl.root}. In development, run \`pnpm seed\` to create it.`, { cause: e });
  }
}

/** arocapi's storage backend over the repository */
export function storage() {
  return backend;
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

async function indexObject(crateId: string, types: string[], force?: boolean) {
  try {
    const ocflObject = repository.object(crateId);
    await ocflObject.load();
    log.debug({ crateId: ocflObject.id }, 'Found OCFL object');
    const jsonContent = await ocflObject.getFile({ logicalPath: 'ro-crate-metadata.json' }).text();
    const rawCrate = JSON.parse(jsonContent);
    const crate = await ROCrate.create(rawCrate);
    for (const t of types) {
      const indexer = INDEXER[t];
      if (indexer) {
        setState(ocflObject.id, t, State.INDEXING);
        try {
          if (force) {
            await indexer.delete(crate.rootId);
          }
          const crateObject = wrap(ocflObject);
          await indexer.index({ crateObject, crate });
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
  const types = type ? ([] as string[]).concat(type) : Object.keys(INDEXER);
  // Given ids are queued before the first await, so callers see them in progress at once
  const ids = typeof crateIds === 'string' || Array.isArray(crateIds) ? [crateIds].flat() : await idsMatching(crateIds);
  for (const id of ids) {
    setState(id, types, State.QUEUED);
  }
  for (const id of ids) {
    await indexObject(id, types, force);
  }
  log.debug('Indexing finished');
}

export async function deleteIndex(crateId?: string, type?: string | string[]) {
  const types = type ? ([] as string[]).concat(type) : Object.keys(INDEXER);
  const indexers = types.map((t) => INDEXER[t]).filter((i) => !!i);
  setState(crateId, types, State.DELETING);
  await Promise.allSettled(indexers.map((indexer) => indexer.delete(crateId)));
  setState(crateId, types);
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
      const jsonContent = await ocflObject.getFile({ logicalPath: 'ro-crate-metadata.json' }).text();
      const jsonParsed = JSON.parse(jsonContent);
      const name = jsonParsed['@graph'].find((e: RawEntity) => e['@id'] === inv.id)?.name?.toString();
      yield { id: inv.id, name, path: ocflObject.root, state: await getState(inv.id) };
    } catch (error) {
      log.error({ err: error, path: ocflObject.root }, 'Error reading object');
    }
  }
}
