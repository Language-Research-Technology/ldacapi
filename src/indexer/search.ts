import { Client } from '@opensearch-project/opensearch';
import { Indexer, RecordType } from "./indexer.ts";
import { logger } from "../index.ts";
import type { Search_Request, Search_RequestBody, Bulk_RequestBody } from '@opensearch-project/opensearch/api/index.d.ts';
import type { ROCrate } from "ro-crate";
import { meta } from 'zod/v4/core';

type searchParams = {
  index?: string;
  searchBody: Search_RequestBody;
  filterPath?: string | string[];
  explain?: boolean;
};

function isText(entity: Record<string, any>) {
  return entity.encodingFormat?.some((ef: any) => (typeof ef === 'string') && ef.startsWith('text/'));
}

const typeIndexer: Record<string, Function> = {
  RepositoryCollection: function (properties: Record<string, any>, entity: Record<string, any>, record: Record<string, any>) {
    return record;
  },
  RepositoryObject: function (properties: Record<string, any>, entity: Record<string, any>, record: Record<string, any>) {
    return record;
  },
  File: function (properties: Record<string, any>, entity: Record<string, any>, record: Record<string, any>) {
    if (isText(entity)) {

    }
    return record;
  }
}

export class SearchIndexer extends Indexer {
  conf;
  client: Client;
  //  conformsTo;
  constructor(opt: any) {
    super(opt);
    this.conf = opt.searchSettings;
    this.client = new Client({ node: process.env.OPENSEARCH_URL });
    // this.conformsTo = {
    //   [configuration.api.conformsTo.collection]: mapCollection,
    //   [configuration.api.conformsTo.object]: mapObject
    //};
  }

  async init() {
    logger.debug('Configure OpenSearch Cluster');
    try {
      const elastic = this.conf;
      await this.client.cluster.putSettings({ body: elastic.cluster });
      if (elastic?.log === 'debug') {
        const config = await this.client.cluster.getSettings();
        logger.debug('Current cluster setting: ' + JSON.stringify(config));
      }
    } catch (e) {
      logger.error('configureCluster');
      logger.error(e);
    }
  }

  async delete(crateId?: string) {
    try {
      if (crateId) {
        await this.client.deleteByQuery({ index: this.conf.indexName, body: { query: { wildcard: { _id: { value: crateId } } } } });
      } else {
        await this.client.indices.delete({ index: this.conf.indexName });
      }
    } catch (error) {
      if ((error as any).meta?.statusCode !== 404) {
        logger.error(error);
      }
    }
  }

  async count() {
    try {
      const res = await this.client.count({ index: this.conf.indexName });
      return res.body.count;
    } catch (e) {
      logger.error(e);
    }
    return 0;
  }

  async search({ index = this.conf.indexName, searchBody, filterPath, explain }: searchParams) {
    try {
      logger.debug("----- searchBody ----");
      logger.debug(JSON.stringify(searchBody));
      logger.debug("----- searchBody ----");
      const opts: Search_Request = {
        index,
        body: searchBody,
        explain: explain,
      }
      if (filterPath) {
        opts.filter_path = filterPath
      }
      logger.debug(JSON.stringify(opts));
      const result = await this.client.search(opts);
      return result.body;
    } catch (e) {
      logger.error(e);
      throw e;
    }
  }

  async _index({ ocflObject, crate }: Parameters<Indexer['_index']>[0]) {
    // create indices if not exists
    const elastic = this.conf;
    try {
      await this.client.indices.create({
        index: elastic.indexName,
        body: elastic.create
      });
      // await this.client.indices.putSettings({
      //   index: elastic.indexName,
      //   body: elastic.index
      // });
    } catch (error) {
      //logger.debug('search index already exists, ignore');
      if ((error as any).meta?.statusCode !== 400) {
        logger.debug(error);
      }
    }
    const operations: Bulk_RequestBody = [];
    for (const entity of crate.entities()) {
      if (entity['@type'].some(t => t in typeIndexer)) {
        const indexRecord = createEntityIndex(elastic, crate, entity, this.defaultLicense);
        const _id: string = indexRecord.rocrateRootId + '/' + indexRecord.entityId;
        operations.push(
          { update: { _index: elastic.indexName, _id } },
          { doc: indexRecord, doc_as_upsert: true }
        );
      }
    }
    try {
      const result = await this.client.bulk({
        body: operations,
        refresh: true, // setting this to true will update result immediately, but will degrade performance
      });
      //console.log(result);
      //if (result.statusCode) return true;
    } catch (error) {
      logger.error('Error indexing ' + crate.rootId);
      logger.error(error);
    }

  }

  async _indexEntity({ ocflObject, crate, entity, parents = [], root }) {
    const isFile = entity['@type'].includes('File');
    const parent = parents.at(-1)?.toJSON();
    const crateId = crate.rootId;
    const entityId = entity['@id'];
    const license = resolveLicense(entity.license || parent?.license, crate, this.defaultLicense);
    if (!license) {
      logger.error(`Skip indexing ${crateId} > ${entityId}, No License Found`);
      return;
    }
    entity.license = license;

    entity._crateId = crateId;
    const doc = crate.getTree({ root: entity, depth: 1, allowCycle: false });
    if (doc.memberOf && doc.memberOf.length) {
      doc._memberOf = doc.memberOf = pickBasic(doc.memberOf);
    } else {
      doc._isTopLevel = "true";
    }
    doc._root = root;
    if (parent) doc._parent = pickBasic(parent);
    doc._collectionStack = parents.map(e => ({ '@id': e['@id'] })); //todo: filter by collection
    const metadataLicense = resolveMetadataLicense(crate, this.defaultMetadataLicense);
    doc._metadataIsPublic = metadataLicense?.metadataIsPublic;
    doc._metadataLicense = metadataLicense;
    indexGeoLocation({ entity, doc });
    if (isFile) {
      indexFile({ entity, doc, ocflObject });
    }

  }

}

function createEntityIndex(elastic: any, crate: ROCrate, entity: Record<string, any>, defaultLicense: string) {
  const { properties } = elastic.create.mappings;
  const license = crate.root.license?.[0]?.['@id'] || defaultLicense;
  const record: Record<string, any> = {
    rocrateRootId: crate.rootId,
    rocrateId: entity['@id'],
    entityId: entity['@id'],
    entityType: entity['@type'].map((t:string) => crate.getContextDefinition(t)),
    //entityType: entity['@type'].map((t:string) => RecordType[t as keyof typeof RecordType]),
    memberOf: entity['pcdm:memberOf'] || entity.memberOf,
    rootCollection: crate.rootId,
    metadataLicenseId: crate.metadata?.license?.[0]['@id'] || '',
    contentLicenseId: entity.license?.[0]?.['@id'] || license
  }
  for (const propName in properties) {
    if (record[propName] == null && entity[propName] != null) {
      record[propName] = entity[propName];
    }
  }

  for (const type of entity['@type'] as string[]) {
    typeIndexer[type]?.(properties, entity, record);
  }
  return record;
}

/**
 * Copy one or more properties from exisiting object
 * @param {string[]} props An array of prop names
 * @param {object} obj Object to copy from
 * @returns {object} 
 */
function pick(props, obj = {}) {
  return Object.fromEntries(props.filter(k => k in obj).map(k => [k, obj[k]]));
}

function pickBasic(obj) {
  return pick(['@id', '@type', 'name'], obj);
}

async function indexFile({ entity, doc, ocflObject }) {
  const entityId = entity['@id'];
  logger.debug(`Index File: ${entityId}`);
  doc.partOf = pickBasic(doc.partOf);
  if (entity.__$contentIndexable[0] && allowTextIndex(entity)) {
    const isText = entity.encodingFormat?.some(ef => (typeof ef === 'string') && ef.startsWith('text/'));
    if (!isText) return;
    try {
      doc._text = await ocflObject.getFile({ logicalPath: entityId }).asString();
      logger.info(`[${doc._crateId}] Indexing: ${entityId}`);
    } catch (e) {
      logger.error(`[${doc._crateId}] Cannot read file: ${entityId}`);
      logger.error(e.message);
      doc._error = 'file_not_found';
    }
  }
}

function allowTextIndex(entity) {
  return entity.license?.some(l => allowTextIndex?.[0]);
}
/**
 * Find the license of an item with its id if not and id or undefined return a default license from
 * config, if passed an Id and not found it will also return a default license.
 * @param {object[]} licenses - Array of licences
 * @param {import('ro-crate').ROCrate} crate
 * @returns a license object
 *
 */
function resolveLicense(licenses, crate, defaultLicense) {
  for (const license of (licenses || [])) {
    const id = typeof license === 'string' ? license : license?.['@id'];
    const entity = crate.getEntity(id);
    if (entity) {
      return entity;
    }
    logger.warn(`Invalid license: ${id}`);
  }
  return defaultLicense;
}

function resolveMetadataLicense(crate, defaultMetadataLicense) {
  const metadataDescriptorLicense = crate.getEntity('ro-crate-metadata.json')?.license || [];
  const license = metadataDescriptorLicense[0];
  if (license) {
    return {
      metadataIsPublic: license.metadataIsPublic?.[0] || false,
      name: license.name?.[0],
      id: license['@id'],
      description: license.description?.[0]
    }
  } else {
    //default to cc-by-4
    return defaultMetadataLicense;
  }
}

function indexGeoLocation({ entity, doc }) {
  var geolocation = doc._geolocation = ['contentLocation', 'spatialCoverage'].flatMap(prop => {
    let result = [];
    if (entity[prop]) {
      result = doc['_' + prop] = entity[prop].flatMap(place => place.geo.flatMap(g => g.asWKT));
    }
    return result;
  });
  doc._centroid = geolocation.map(calculateCentroid);
}

function calculateCentroid(wkt = []) {
  // extract all coordinates from wkt string into a flat array
  var coordinates = wkt.replace(/(^\w+\s+)|[()]/g, '').split(',').
    map(e => e.trim().split(/\s+/).map(n => +n));
  var len = coordinates.length;
  if (len) {
    var [sumLng, sumLat] = coordinates.reduce((sum, point) => sum.map((n, i) => n + point[i]), [0, 0]);
    var centroid = [sumLng / len, sumLat / len];
    return `POINT (${centroid[0]} ${centroid[1]})`;
  }
}
