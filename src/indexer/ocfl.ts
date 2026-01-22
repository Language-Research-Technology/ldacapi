import type { OcflStorage, OcflObject } from "@ocfl/ocfl";
import { ROCrate } from "ro-crate";
import { logger } from "../index.ts";
import { StructuralIndexer } from "./structural.ts";
import { SearchIndexer } from "./search.ts";
import { Indexer } from "./indexer.ts";

const defaultLicense = 'https://opensource.org/licenses/MIT';
const defaultMetadataLicense = 'https://opensource.org/licenses/MIT';
const ocflPath = '/opt/storage/oni/ocfl';
const ocflPathInternal = 'ocfl';
const searchSettings = {
  cluster: {
    persistent: {
      "search.max_open_scroll_context": 5000
    },
    transient: {
      "search.max_open_scroll_context": 5000
    }
  },
  index: {
    mapping: {
      _source: {
        excludes: ['_text']
      },
      properties: {
        rocrateId: { type: 'keyword' },
        name: {
          type: 'text',
          fields: {
            keyword: { type: 'keyword' },
          },
        },
        description: { type: 'text' },
        entityType: { type: 'keyword' },
        conformsTo: { type: 'keyword' },
        //recordType: { type: 'keyword' },
        memberOf: { type: 'keyword' },
        rootCollection: { type: 'keyword' },
        //root: { type: 'keyword' },
        metadataLicenseId: { type: 'keyword' },
        contentLicenseId: { type: 'keyword' },
        inLanguage: { type: 'keyword' },
        location: { type: 'geo_point' },
        mediaType: { type: 'keyword' },
        communicationMode: { type: 'keyword' },
        // createdAt: { type: 'date' },
        // updatedAt: { type: 'date' },
      },
      total_fields: {
        limit: 1000
      }
    },
    max_result_window: 100000,
    highlight: {
      max_analyzer_offset: 1000000
    }
  },
  indexName: 'entities'
};
let INDEXER: { [key: string]: Indexer };

export async function init() {
  INDEXER = {
    structural: await StructuralIndexer.create({
      defaultLicense, defaultMetadataLicense, ocflPath, ocflPathInternal
    }),
    search: await SearchIndexer.create({
      defaultLicense, defaultMetadataLicense, searchSettings
    })
  };
}

export async function getIndexerState(crateId?: string, type?: string) {
  return {
    isIndexed: false,
    isIndexing: false,
    isDeleting: false
  }
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
          await indexer.index({ ocflObject, crate });
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

export async function createIndex(repository: OcflStorage, crateId?: string | RegExp, type?: string, force?: boolean) {
  logger.debug('Indexing started');
  const types = type ? [type] : ['structural', 'search'];
  if (crateId) {
    if (typeof crateId === 'string') {
      await indexObject(repository.object(crateId), types, force);
    } else {
      for await (const ocflObject of repository) {
        const inv = await ocflObject.getInventory();
        // if crateId is specified, index just the object and the subcollections and child objects
        // by checking just the structure implied in the crate id
        if (!crateId || (crateId instanceof RegExp && inv.id.match(crateId))) {
          await indexObject(ocflObject, types, force);
        }
      }
    }
  } else {
    for await (const ocflObject of repository) {
      await indexObject(ocflObject, types, force);
    }
  }
  logger.debug('Indexing finished');
}

export async function deleteIndex() {
  await Promise.allSettled(Object.values(INDEXER).map(indexer => indexer.delete()));
}