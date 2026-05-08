import { Client } from '@opensearch-project/opensearch';
import type {
  Bulk_RequestBody,
  Search_Request,
  Search_RequestBody,
} from '@opensearch-project/opensearch/api/index.d.ts';
import type { ROCrate } from 'ro-crate';
import { log } from '../utils.ts';
import { PromiseQueue, firstStringOrId } from '../utils.ts';
import type { CrateObject } from './indexer.ts';
import { Indexer, RecordType } from './indexer.ts';
import { dataTypeMapper, mapDefaultProperties, propertyMapper } from './search_mapper.ts';

/**
 * Notes:
 * Index properties:
 * - id must exists and be the same as the id used in postgres
 */
type searchParams = {
  index?: string;
  searchBody: Search_RequestBody;
  filterPath?: string | string[];
  explain?: boolean;
};

function isText(entity: Record<string, any>) {
  return entity.encodingFormat?.some((ef: any) => typeof ef === 'string' && ef.startsWith('text/'));
}

type MapperParams = {
  properties?: Record<string, any>;
  entity: Record<string, any>;
  record: Record<string, any>;
  crate: ROCrate;
  crateObject?: CrateObject;
  /** An entity queue to be indexed one-by-one separately */
  deferredEntities?: Record<string, any>[];
};

/** The function mapped here may return an array of entities to be processed in batch  */
const typeMapper: Record<string, (params: MapperParams) => Record<string, any>> = Object.fromEntries(
  Object.entries(RecordType).map(([k, _v]) => [k, ({ record }) => record]),
);

const batchedTypeIndexer: Record<string, (params: MapperParams) => Promise<Record<string, any>>> = {
  File: async function ({ entity, record, crate, crateObject }) {
    //todo: check licence if it allows indexing content
    if (isText(entity)) {
      const entityId = entity['@id'];
      try {
        record._text = (await crateObject?.text(entityId)) || '';
        log.info(`[search] Indexing File: ${entityId}`);
      } catch (e) {
        log.error(`[search] Cannot read file: ${entityId}`);
        log.error(e);
        record._error = 'file_not_found';
      }
    }
    return record;
  },
};

export class SearchIndexer extends Indexer {
  conf;
  client: Client;
  propertyMapper = { ...propertyMapper };
  //  conformsTo;
  constructor(opt: any) {
    super(opt);
    this.conf = opt.searchSettings;
    this.client = opt.client || new Client({ node: process.env.OPENSEARCH_URL });
    // this.conformsTo = {
    //   [configuration.api.conformsTo.collection]: mapCollection,
    //   [configuration.api.conformsTo.object]: mapObject
    //};
    const { properties } = this.conf.create.mappings;
    for (const name in properties) {
      const mapper = dataTypeMapper[properties[name].type];
      if (mapper && !this.propertyMapper[name]) {
        this.propertyMapper[name] = mapper;
      }
    }
  }

  async init() {
    log.debug('Configure OpenSearch Cluster');
    try {
      const elastic = this.conf;
      await this.client.cluster.putSettings({ body: elastic.cluster });
      if (elastic?.log === 'debug') {
        const config = await this.client.cluster.getSettings();
        log.debug('Current cluster setting: ' + JSON.stringify(config));
      }
    } catch (e) {
      log.error('configureCluster');
      log.error(e);
    }
  }

  async delete(crateId?: string) {
    try {
      if (crateId) {
        await this.client.deleteByQuery({
          index: this.conf.entityIndex,
          body: { query: { prefix: { rocrateRootId: { value: crateId } } } },
        });
      } else {
        await this.client.indices.delete({ index: this.conf.entityIndex });
      }
      log.debug(`[search] Index ${crateId || '<all>'} deleted`);
    } catch (error) {
      if ((error as any).meta?.statusCode !== 404) {
        log.error(error);
      }
    }
  }

  async count() {
    try {
      const res = await this.client.count({ index: this.conf.entityIndex });
      return res.body.count;
    } catch (e) {
      log.error(e);
    }
    return 0;
  }

  async _index({ crateObject, crate, license, metadataLicense }: Parameters<Indexer['_index']>[0]) {
    // create indices if not exists
    const elastic = this.conf;
    try {
      await this.client.indices.create({
        index: elastic.entityIndex,
        body: elastic.create,
      });
      // await this.client.indices.putSettings({
      //   index: elastic.entityIndex,
      //   body: elastic.index
      // });
    } catch (error) {
      //logger.debug('search index already exists, ignore');
      if ((error as any).meta?.statusCode !== 400) {
        log.debug(error);
      }
    }
    const { properties } = elastic.create.mappings;
    const operations: Bulk_RequestBody = [];
    const deferredEntities: any[] = []; // for individual updates
    const deriveId = (entityId: string) => this.deriveUniqueEntityId(crate.rootId, entityId);

    for (const entity of crate.entities()) {
      const entityTypes: string[] = entity['@type'];
      const matchedMappers = entityTypes.map((t) => !RecordType[t] || entity.conformsTo?.find(c => c['@id'] === RecordType[t]) ? typeMapper[t] : undefined).filter((fn) => !!fn);
      if (matchedMappers.length) {
        // create common index record
        const _id = deriveId(entity['@id']);
        // const license = resolveLicense(entity.license || parent?.license, crate, this.defaultLicense);
        // if (!license) {
        //   logger.error(`Skip indexing ${crateId} > ${entityId}, No License Found`);
        //   return;
        // }
        // const metadataLicense = resolveMetadataLicense(crate, this.defaultMetadataLicense);
        // doc._metadataIsPublic = metadataLicense?.metadataIsPublic;
        // doc._metadataLicense = metadataLicense;
        let record = createDoc(crate, entity, _id, license, metadataLicense, deferredEntities, this.propertyMapper);
        log.debug(`[structural] Adding ${_id}`);
        // add additional information to record based on type
        for (const mapType of matchedMappers) {
          record = mapType({ properties, entity, record, crate, crateObject });
        }
        //console.log(record);
        operations.push({ update: { _index: elastic.entityIndex, _id } }, { doc: record, doc_as_upsert: true });
      }
    }
    try {
      const result = await this.client.bulk({
        body: operations,
        refresh: true, // setting this to true will update result immediately, but will degrade performance
      });
      if (result.body.errors) {
        log.error(`[search] Bulk operation result errors:`);
        const items = result.body.items.filter((item) => item.update.error).map((item) => item.update.error?.reason);
        log.error(items.join('\n'));
      }
      // index bigger data such as file content in a separate step to manage payload size
      const pq = new PromiseQueue(4, async (entity) => {
        const entityTypes: string[] = entity['@type'];
        const matchedIndexers = entityTypes.map((t) => batchedTypeIndexer[t]).filter((fn) => !!fn);
        let doc = {};
        for (const mapper of matchedIndexers) {
          doc = await mapper({ properties, entity, record: doc, crate, crateObject });
        }
        //console.log(doc);
        const result = await this.client.update({
          index: elastic.entityIndex,
          id: deriveId(entity['@id']),
          body: { doc, doc_as_upsert: true },
        });
        log.debug(
          `[search] Batched operation result: ${result.body._id} ${result.body.result} ${result.statusCode}`,
        );
      });
      for (const entity of deferredEntities) {
        await pq.enqueue(entity);
      }
      await pq.done();
      await this.client.indices.refresh({ index: elastic.entityIndex });
    } catch (error) {
      log.error('Error indexing ' + crate.rootId);
      log.error(error);
    }
  }

  async search({ index = this.conf.entityIndex, searchBody, filterPath, explain }: searchParams) {
    try {
      log.debug('----- searchBody ----');
      log.debug(JSON.stringify(searchBody));
      log.debug('----- searchBody ----');
      const opts: Search_Request = {
        index,
        body: searchBody,
        explain: explain,
      };
      if (filterPath) {
        opts.filter_path = filterPath;
      }
      log.debug(JSON.stringify(opts));
      const result = await this.client.search(opts);
      return result.body;
    } catch (e) {
      log.error(e);
      throw e;
    }
  }
}

/** Create entity basic record for bulk indexing */
function createDoc(
  crate: ROCrate,
  entity: Record<string, any>,
  _id: string,
  license: string,
  metadataLicense: string,
  deferredEntities: any[],
  propMapper: typeof propertyMapper = {},
) {
  const record: Record<string, any> = {
    rocrateRootId: crate.rootId, // The id of the entity that represent the original rocrate in the repository
    id: _id, // Prefixed entity id because each entity is being splited up logically into a separate rocrate doc
    entityId: entity['@id'], // Original entity id
    entityType: entity['@type'].map((t: string) => crate.getContextDefinition(t)),
    //entityType: entity['@type'].map((t:string) => RecordType[t as keyof typeof RecordType]),
    //memberOf: entity['pcdm:memberOf'] || entity.memberOf,
    rootCollection: crate.rootId,
    metadataLicenseId: metadataLicense,
    contentLicenseId: firstStringOrId(entity.license) || license,
    '@id': entity['@id'],
  };
  //handle inverse relations
  crate.addValues(entity, 'isPartOf', entity['@reverse'].hasPart);
  crate.addValues(entity, 'hasPart', entity['@reverse'].isPartOf);
  crate.addValues(entity, 'pcdm:memberOf', entity['@reverse']['pcdm:hasMember']);
  crate.addValues(entity, 'pcdm:hasMember', entity['@reverse']['pcdm:memberOf']);

  for (const propName in entity) {
    if (record[propName] == null && entity[propName] != null && entity[propName].length) {
      //console.log(propName, entity[propName]);
      const pm = propMapper[propName] || mapDefaultProperties;
      const values = [];
      for (const value of entity[propName]) {
        const properties = {};
        const res = pm(value, { deferredEntities, properties });
        for (const name in properties) {
          const vals = properties[name];
          if (vals == null) continue;
          if (record[name] == null) {
            record[name] = vals;
          } else {
            if (!Array.isArray(record[name])) record[name] = [record[name]];
            for (const v of vals) record[name].push(v);
          }
        }
        if (res != null) values.push(res);
      }
      if (values.length) record[propName] = values;
      //console.log(propName, record[propName]);
    }
  }

  return record;
}

/**
 * Find the license of an item with its id if not and id or undefined return a default license from
 * config, if passed an Id and not found it will also return a default license.
 */
function _resolveLicense(licenses: any[], crate: ROCrate, defaultLicense: any) {
  for (const license of licenses || []) {
    const id = typeof license === 'string' ? license : license['@id'];
    const entity = crate.getEntity(id);
    if (entity) {
      return entity;
    }
    log.warn(`Invalid license: ${id}`);
  }
  return defaultLicense;
}

function _resolveMetadataLicense(crate, defaultMetadataLicense) {
  const metadataDescriptorLicense = crate.getEntity('ro-crate-metadata.json')?.license || [];
  const license = metadataDescriptorLicense[0];
  if (license) {
    return {
      metadataIsPublic: license.metadataIsPublic?.[0] || false,
      name: license.name?.[0],
      id: license['@id'],
      description: license.description?.[0],
    };
  } else {
    //default to cc-by-4
    return defaultMetadataLicense;
  }
}
