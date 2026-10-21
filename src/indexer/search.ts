import type { Client } from '@opensearch-project/opensearch';
import type { FieldDeclarations, GeoPoint, SearchDocument } from 'arocapi';
import { OpenSearchBackend } from 'arocapi/opensearch';
import type { Entity, ROCrate } from 'ro-crate';
import { config } from '../configuration.ts';
import { firstStringOrId, log as plog } from '../utils.ts';
import type { BaseOptions, CrateObject } from './indexer.ts';
import { Indexer, recordType } from './indexer.ts';
import { pickSingleMemberOf } from './structural.ts';

const log = plog.child({ module: 'indexer/search' });

const fields = {
  name: { type: 'text', label: 'Name', weight: 3, advanced: true, sort: true },
  description: { type: 'text', label: 'Description', advanced: true },
  text: { type: 'text', label: 'Text', advanced: true },
  type: { type: 'keyword', label: 'Record Type', facet: true },
  inLanguage: { type: 'keyword', label: 'Language', advanced: true, facet: true },
  communicationMode: { type: 'keyword', label: 'Communication Mode', facet: true },
  linguisticGenre: { type: 'keyword', label: 'Linguistic Genre', facet: true },
  annotationType: { type: 'keyword', label: 'Annotation Type', facet: true },
  encodingFormat: { type: 'keyword', label: 'File Format', facet: true },
  rootCollection: { type: 'keyword', label: 'Collection', facet: true },
  memberOf: { type: 'keyword', label: 'Member Of', facet: true },
  license: { type: 'keyword', label: 'License', facet: true },
  datePublished: { type: 'date', label: 'Date Published', filter: true, sort: true },
  dateCreated: { type: 'date', label: 'Date Created', filter: true },
  temporalCoverage: { type: 'date', label: 'Temporal Coverage', filter: true },
  location: { type: 'geo' },
} as const satisfies FieldDeclarations;

type Document = SearchDocument<typeof fields>;

export const createSearchBackend = (client: Client) => OpenSearchBackend({ client, fields, indexName: config.search.entityIndex });

type SearchBackend = ReturnType<typeof createSearchBackend>;

type SearchOptions = BaseOptions & {
  client: Client;
  search: SearchBackend;
};

const values = (entity: Entity, name: string): unknown[] => [...(entity[name] ?? []), ...(entity[`ldac:${name}`] ?? [])];

/** Linked entities by name, falling back to their id; literals as they are */
const labels = (entity: Entity, name: string) => {
  const found = values(entity, name).map((value) => {
    if (typeof value !== 'object' || value === null) {
      return typeof value === 'string' ? value : undefined;
    }
    const { name, '@id': id, '@value': literal } = value as { name?: unknown[]; '@id'?: string; '@value'?: unknown };
    return [name?.[0], literal, id].find((v): v is string => typeof v === 'string');
  });
  return [...new Set(found.filter((v): v is string => !!v))];
};

const DATE = /^\d{4}(-\d{2}(-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?)?)?$/;

/** The start of each date or date range (`2001/2005`) */
const dates = (entity: Entity, name: string) =>
  labels(entity, name)
    .map((value) => (value.split('/')[0] ?? '').trim())
    .filter((value) => DATE.test(value));

const WKT_POINT = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/;

function pointOf(place: Record<string, unknown[] | undefined>): GeoPoint | undefined {
  const lat = Number(place.latitude?.[0]);
  const lng = Number(place.longitude?.[0]);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng };
  }
  for (const geo of [...(place.geo ?? []), ...(place.asWKT ?? [])]) {
    if (typeof geo === 'string') {
      const match = WKT_POINT.exec(geo);
      if (match) {
        return { lat: Number(match[2]), lng: Number(match[1]) };
      }
    } else if (geo && typeof geo === 'object') {
      const point = pointOf(geo as Record<string, unknown[] | undefined>);
      if (point) {
        return point;
      }
    }
  }
}

/** The first point of the entity's first place: the search backend holds one per entity */
function location(entity: Entity) {
  for (const place of [...values(entity, 'contentLocation'), ...values(entity, 'spatialCoverage')]) {
    const point = typeof place === 'object' && place !== null ? pointOf(place as Record<string, unknown[] | undefined>) : undefined;
    if (point) {
      return point;
    }
  }
}

function isText(entity: Entity) {
  return entity.encodingFormat?.some((ef: unknown) => typeof ef === 'string' && ef.startsWith('text/'));
}

/** One entity's search document; File entities with text content include it */
export async function searchDocument(crate: ROCrate, crateObject: CrateObject, entity: Entity, license: string): Promise<Document> {
  const id: string = entity['@id'];
  const [datePublished] = dates(entity, 'datePublished');
  const memberOf = pickSingleMemberOf(entity);
  const point = location(entity);
  const doc: Document = {
    id,
    name: entity.name?.join('; ') || id,
    description: labels(entity, 'description'),
    type: entity['@type'],
    inLanguage: labels(entity, 'inLanguage'),
    communicationMode: labels(entity, 'communicationMode'),
    linguisticGenre: labels(entity, 'linguisticGenre'),
    annotationType: labels(entity, 'annotationType'),
    encodingFormat: labels(entity, 'encodingFormat'),
    rootCollection: crate.rootId,
    ...(memberOf && { memberOf }),
    license: firstStringOrId(entity.license) || license,
    ...(datePublished && { datePublished }),
    dateCreated: dates(entity, 'dateCreated'),
    temporalCoverage: dates(entity, 'temporalCoverage'),
    ...(point && { location: point }),
  };
  if (isText(entity)) {
    const path = id.startsWith(crate.rootId) ? id.replace(`${crate.rootId}/`, '') : id;
    try {
      doc.text = await crateObject.text(path);
      log.info(`Indexing File: ${path}`);
    } catch (error) {
      log.error(`Cannot read file ${path}: ${(error as Error).message}`);
    }
  }
  return doc;
}

export class SearchIndexer extends Indexer {
  client: Client;
  search: SearchBackend;
  indexName: string;

  constructor(opt: SearchOptions) {
    super(opt);
    this.client = opt.client;
    this.search = opt.search;
    this.indexName = config.search.entityIndex;
  }

  /** arocapi creates the index with its mapping only, so a template supplies our settings */
  async init() {
    await this.client.indices.putIndexTemplate({
      name: this.indexName,
      body: {
        index_patterns: [this.indexName],
        template: { settings: { index: { auto_expand_replicas: '0-1', max_result_window: 100000 } } },
      },
    });
    await this.search.createIndex();
  }

  async delete(crateId?: string) {
    if (crateId) {
      await this.client.deleteByQuery({ index: this.indexName, refresh: true, body: { query: { term: { rootCollection: crateId } } } });
    } else {
      await this.client.indices.delete({ index: this.indexName, ignore_unavailable: true });
    }
    log.debug(`Index ${crateId || '<all>'} deleted`);
  }

  async count(crateId?: string) {
    try {
      const res = await this.client.count({
        index: this.indexName,
        ...(crateId && { body: { query: { term: { rootCollection: crateId } } } }),
      });
      return res.body.count;
    } catch {
      return 0;
    }
  }

  async _index({ crateObject, crate, license }: Parameters<Indexer['_index']>[0]) {
    await this.search.createIndex();
    const docs: Document[] = [];
    for (const entity of crate.entities()) {
      if (!recordType(entity)) {
        continue;
      }
      const doc = await searchDocument(crate, crateObject, entity, license);
      if (doc.text) {
        // Indexed alone to keep each request small
        await this.indexDocuments([doc]);
      } else {
        docs.push(doc);
      }
    }
    await this.indexDocuments(docs);
    await this.client.indices.refresh({ index: this.indexName });
  }

  /** Index a batch, falling back to one at a time so one bad document doesn't lose the rest */
  async indexDocuments(docs: Document[]) {
    if (!docs.length) {
      return;
    }
    try {
      await this.search.index(docs);
    } catch (error) {
      if (docs.length === 1) {
        log.error(`Error indexing ${docs[0]?.id}: ${(error as Error).message}`);
        return;
      }
      for (const doc of docs) {
        await this.indexDocuments([doc]);
      }
    }
  }
}
