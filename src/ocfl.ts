import type { OcflObject } from '@ocfl/ocfl';
import { ROCrate } from 'ro-crate';
import { logger } from './index.ts';
import { StructuralIndexer } from './indexer/structural.ts';
import { SearchIndexer } from './indexer/search.ts';
import { Indexer } from './indexer/indexer.ts';
import type { CrateObject } from './indexer/indexer.ts';
import ocfl from '@ocfl/ocfl-fs';
import { config } from './configuration.ts';
import { Readable } from 'node:stream';

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

const defaultLicense = 'https://opensource.org/licenses/MIT';
const defaultMetadataLicense = 'https://opensource.org/licenses/MIT';
const ocflPath = '/opt/storage/oni/ocfl';
const ocflPathInternal = 'ocfl';

let INDEXER: { [key: string]: Indexer };
let repository: ReturnType<typeof ocfl.storage>;

export async function init(opts: any) {
  logger.info('Initializing OCFL repository and indexers');
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
    logger.error('=======================================');
    logger.error('Repository Error: please check your OCFL');
    logger.error((e as Error).message);
    logger.error(JSON.stringify(ocflConf));
    logger.error('=======================================');
    throw e;
  }
}

function wrap(ocflObject: OcflObject): CrateObject {
  return {
    root: ocflObject.root,
    text: async (path: string) => {
      return await ocflObject.getFile({ logicalPath: path }).text();
    },
  };
}

export async function getIndexerState(crateId?: string, type?: string) {
  return {
    isIndexed: false,
    isIndexing: false,
    isDeleting: false,
  };
}

async function indexObject(ocflObject: OcflObject, types: string[], force?: boolean) {
  if (!ocflObject) return;
  try {
    await ocflObject.load();
    logger.debug(`Found OFCL object: ${ocflObject.id}`);
    const jsonContent = await ocflObject.getFile({ logicalPath: 'ro-crate-metadata.json' }).text();
    const rawCrate = JSON.parse(jsonContent);
    const crate = await ROCrate.create(rawCrate);
    for (const t of types) {
      const indexer = INDEXER[t];
      if (indexer) {
        try {
          if (force) await indexer.delete(crate.rootId);
          const crateObject = wrap(ocflObject);
          await indexer.index({ crateObject, crate });
          // counts[t]++;
        } catch (error) {
          logger.error(error);
        }
      }
    }
  } catch (e) {
    logger.error(e);
  }
}

export async function createIndex(crateId?: string | RegExp, type?: string, force?: boolean) {
  logger.debug('Indexing started');
  const types = type ? [type] : ['structural', 'search'];
  if (typeof crateId === 'string') {
    await indexObject(repository.object(crateId), types, force);
  } else {
    // process IO in parallel
    const batchedResults = Readable.from(repository).map(
      async (ocflObject) =>
        // if crateId is specified, index just the object and the subcollections and child objects
        // by checking just the structure implied in the crate id
        !(crateId instanceof RegExp) || (await ocflObject.getInventory())?.id.match(crateId)
          ? indexObject(ocflObject, types, force)
          : undefined,
      { concurrency: 4 },
    );
    for await (const result of batchedResults) {}
  }
  logger.debug('Indexing finished');
}

export async function deleteIndex(crateId?: string, type?: string | string[]) {
  const indexers = type
    ? ([] as string[])
        .concat(type)
        .map((t) => INDEXER[t])
        .filter((i) => !!i)
    : Object.values(INDEXER);
  await Promise.allSettled(indexers.map((indexer) => indexer.delete(crateId)));
}

export async function* objects(base: string) {
  //TODO: implement listing only top-level collections
  for await (const ocflObject of repository) {
    try {
      const inv = await ocflObject.getInventory();
      const jsonContent = await ocflObject.getFile({ logicalPath: 'ro-crate-metadata.json' }).text();
      const jsonParsed = JSON.parse(jsonContent);
      const name = jsonParsed['@graph'].find((e: any) => e['@id'] === inv.id)?.name?.toString();
      yield { id: inv.id, name, path: ocflObject.root };
    } catch (error) {
      logger.error(error);
    }
  }
}
