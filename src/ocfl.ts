import type { OcflObject } from '@ocfl/ocfl';
import ocfl from '@ocfl/ocfl-fs';
import type { Client } from '@opensearch-project/opensearch';
import { createCRC32 } from 'hash-wasm';
import { type RawEntity, ROCrate } from 'ro-crate';
import { config } from './configuration.ts';
import type { CrateObject, Indexer } from './indexer/indexer.ts';
import { SearchIndexer } from './indexer/search.ts';
import { StructuralIndexer } from './indexer/structural.ts';
import { type RepositoryFile, State } from './repository.ts';
import { log, PromiseQueue } from './utils.ts';

const crc32 = await createCRC32();

const ocflConf = {
  ocflPath: '/opt/storage/oni/ocfl',
  ocflPathInternal: '/ocfl',
  ocflScratch: '/opt/storage/oni/scratch-ocfl',
  ocflTestPath: '/opt/storage/oni/test/ocfl',
  ocflTestScratch: '/opt/storage/oni/test/scratch-ocfl',
  catalogFilename: 'ro-crate-metadata.json',
  hashAlgorithm: 'md5',
  create: {
    repoName: 'LDACA',
    collections: '../test-data/ingest-crate-list.development.json',
  },
  previewPath: '/opt/storage/oni/temp/ocfl/previews/',
  previewPathInternal: '/ocfl/previews',
};

const { defaultLicense, defaultMetadataLicense } = config;
const ocflPath = '/opt/storage/oni/ocfl';
const ocflPathInternal = 'ocfl';

const stateCache: { [key: string]: { [key: string]: (typeof State)[keyof typeof State] | undefined } } = {};
let INDEXER: { [key: string]: Indexer };
let repository: ReturnType<typeof ocfl.storage>;

export async function init(opts: { opensearchClient?: Client }) {
  log.info('Initializing OCFL repository and indexers');
  INDEXER = {
    structural: await StructuralIndexer.create({
      defaultLicense,
      defaultMetadataLicense,
      ocflPath,
      ocflPathInternal,
    }),
    search: await SearchIndexer.create({
      defaultLicense,
      defaultMetadataLicense,
      searchSettings: config.search,
      client: opts.opensearchClient,
    }),
  };
  repository = ocfl.storage({
    root: ocflConf.ocflPath,
    workspace: ocflConf.ocflScratch,
    ocflVersion: '1.1',
    fixityAlgorithms: ['crc32'],
    layout: {
      extensionName: '000N-path-direct-storage-layout',
    },
  });
  try {
    await repository.load();
  } catch (e) {
    log.error('=======================================');
    log.error('Repository Error: please check your OCFL');
    log.error((e as Error).message);
    log.error(JSON.stringify(ocflConf));
    log.error('=======================================');
    throw e;
  }
}

async function calculateCrc32(file: RepositoryFile) {
  crc32.init();
  for await (const chunk of await file.stream()) {
    crc32.update(chunk);
  }
  return crc32.digest('hex');
}

function wrap(ocflObject: OcflObject): CrateObject {
  return {
    root: ocflObject.root,
    async text(path: string) {
      return await ocflObject.getFile({ logicalPath: path }).text();
    },
    async file(path: string) {
      const file = ocflObject.getFile({ logicalPath: path });
      if (!file) {
        throw new Error(`File not found in ocfl inventory: ${path}`);
      }
      return {
        size: file.size ?? file.fixity?.size ?? (await file.stat()).size,
        crc32: file.fixity?.crc32 ?? (await calculateCrc32(file)),
      };
    },
  };
}

function _setState(crateId: string, types: string | string[], state?: (typeof State)[keyof typeof State]) {
  stateCache[crateId] = stateCache[crateId] || {};
  for (const type of ([] as string[]).concat(types)) {
    stateCache[crateId][type] = state;
  }
}

function setState(crateId: string | undefined, types: string | string[], state?: (typeof State)[keyof typeof State]) {
  if (crateId) {
    _setState(crateId, types, state);
  } else {
    for (const id in stateCache) {
      _setState(id, types, state);
    }
  }
}

export async function getState(crateId: string, type?: string) {
  const indexers: [string, Indexer][] = type ? [[type, INDEXER[type]]] : Object.entries(INDEXER);
  for (const [name, indexer] of indexers) {
    if (!indexer) return;
    if (!stateCache[crateId]?.[name]) {
      const count = await INDEXER[name].count(crateId);
      if (count > 0) {
        stateCache[crateId] = stateCache[crateId] || {};
        stateCache[crateId][name] = State.INDEXED;
      }
    }
    //if (!StateCache[crateId]?.[name]) return State.NONE;
  }
  return type ? { [type]: stateCache[crateId][type] } : (stateCache[crateId] ?? {});
}

async function indexObject(ocflObject: OcflObject, types: string[], force?: boolean) {
  if (!ocflObject) return;
  try {
    log.debug(`Found OFCL object: ${ocflObject.id}`);
    const jsonContent = await ocflObject.getFile({ logicalPath: 'ro-crate-metadata.json' }).text();
    const rawCrate = JSON.parse(jsonContent);
    const crate = await ROCrate.create(rawCrate);
    for (const t of types) {
      const indexer = INDEXER[t];
      if (indexer) {
        setState(ocflObject.id, t, State.INDEXING);
        try {
          if (force) await indexer.delete(crate.rootId);
          const crateObject = wrap(ocflObject);
          await indexer.index({ crateObject, crate });
          // counts[t]++;
        } catch (error) {
          log.error(error);
        } finally {
          setState(ocflObject.id, t);
        }
      }
    }
  } catch (e) {
    log.error(e);
  }
}

export async function createIndex(crateId?: string | RegExp, type?: string | string[], force?: boolean) {
  log.debug('Indexing started');
  const types = type ? ([] as string[]).concat(type) : Object.keys(INDEXER);
  if (typeof crateId === 'string') {
    await indexObject(repository.object(crateId), types, force);
  } else {
    // process IO in parallel
    const pq = new PromiseQueue(4, async (ocflObject: unknown) => indexObject(ocflObject, types, force));
    if (crateId instanceof RegExp) {
      // if crateId pattern is specified, index just the object and the subcollections and child objects
      // by checking just the structure implied in the crate id
      for await (const ocflObject of repository) {
        await ocflObject.load();
        if (ocflObject.id.match(crateId)) {
          setState(ocflObject.id, types, State.QUEUED);
          await pq.enqueue(ocflObject);
        }
      }
    } else {
      // otherwise, index everything
      for await (const ocflObject of repository) {
        await ocflObject.load();
        setState(ocflObject.id, types, State.QUEUED);
        await pq.enqueue(ocflObject);
      }
    }
    await pq.done();
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
      log.error(error);
    }
  }
}

export async function getFile(entityId: string, storagePath: string) {
  const crateId = storagePath && entityId.endsWith(`/${storagePath}`) ? entityId.slice(0, -storagePath.length - 1) : entityId;
  try {
    const object = repository.object(crateId);
    await object.load();
    const file = object.getFile({ logicalPath: storagePath });
    //console.log(file);
    return {
      path: `${repository.objectRoot(crateId)}/${file.contentPath}`,
      stream: async () => file.stream(),
    };
  } catch (error) {
    log.error(error);
  }
}
