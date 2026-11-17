import type { GeoPoint } from 'arocapi';
import type { Entity, ROCrate } from 'ro-crate';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { logger } from '../logger.ts';
import { COLLECTION, OBJECT } from '../oni.ts';
import type { Document, SearchBackend } from '../search-backend.ts';
import { firstStringOrId } from '../utils.ts';
import { crateRows, pickSingleMemberOf } from './rows.ts';
import { type CrateObject, entityClass, type Licences, recordType, type WriteParams, Writer } from './writer.ts';

const log = logger.child({ module: 'indexer/documents' });

/** Well under OpenSearch's default `index.max_terms_count` of 65,536 */
const BATCH_SIZE = 10_000;

const batches = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / BATCH_SIZE) }, (_, i) => items.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE));

const CLASS_LABELS: Record<string, string> = {
  [COLLECTION]: 'Collection',
  [OBJECT]: 'Object',
  'http://schema.org/MediaObject': 'File',
  'http://schema.org/Person': 'Person',
  'http://schema.org/Organization': 'Organisation',
  'http://schema.org/SoftwareApplication': 'Software Application',
};

/** A readable label for a class URI, either schema.org scheme alike, falling back to its last segment */
const classLabel = (uri: string) =>
  CLASS_LABELS[uri.replace(/^https:\/\/schema\.org\//, 'http://schema.org/')] ?? uri.slice(Math.max(uri.lastIndexOf('#'), uri.lastIndexOf('/')) + 1);

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
    .map((value) => value.replace(/\/.*/, '').trim())
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
export async function searchDocument(
  crate: ROCrate,
  crateObject: CrateObject,
  entity: Entity,
  license: string,
  rootCollection: string | null,
  path?: string,
): Promise<Document> {
  const id: string = entity['@id'];
  const type = recordType(entity);
  const entityType = type && entityClass(crate, type);
  const [datePublished] = dates(entity, 'datePublished');
  const memberOf = pickSingleMemberOf(entity);
  const point = location(entity);
  const doc: Document = {
    id,
    name: entity.name?.join('; ') || id,
    description: labels(entity, 'description'),
    ...(entityType && { entityType, recordType: classLabel(entityType) }),
    inLanguage: labels(entity, 'inLanguage'),
    communicationMode: labels(entity, 'communicationMode'),
    linguisticGenre: labels(entity, 'linguisticGenre'),
    annotationType: labels(entity, 'annotationType'),
    encodingFormat: labels(entity, 'encodingFormat'),
    ...(rootCollection && { rootCollection }),
    ...(memberOf && { memberOf }),
    license: firstStringOrId(entity.license) || license,
    ...(datePublished && { datePublished }),
    dateCreated: dates(entity, 'dateCreated'),
    temporalCoverage: dates(entity, 'temporalCoverage'),
    ...(point && { location: point }),
  };
  if (path && isText(entity)) {
    try {
      doc.text = await crateObject.text(path);
      log.debug({ crateId: crate.rootId, path }, 'Indexing file text');
    } catch (error) {
      log.error({ err: error, crateId: crate.rootId, path }, 'Cannot read file');
    }
  }
  return doc;
}

/** Writes a crate's search documents, one for each entity with a row */
export class DocumentsWriter extends Writer {
  prisma: PrismaClient;
  search: SearchBackend;

  constructor(prisma: PrismaClient, search: SearchBackend, licences: Licences) {
    super(licences);
    this.prisma = prisma;
    this.search = search;
  }

  /** Run before the rows are deleted, as it finds the documents by them */
  async delete(crateId: string) {
    const ids = (await crateRows(this.prisma, crateId)).map(({ id }) => id);
    for (const batch of batches(ids)) {
      await this.search.remove(batch);
    }
  }

  /** Only entities with a row, as arocapi drops a hit without one but still counts it */
  async write({ crateObject, crate, paths, license }: WriteParams) {
    const crateId = crate.rootId;
    const rows = new Map((await crateRows(this.prisma, crateId)).map(({ id, rootCollection }) => [id, rootCollection]));
    const docs: Document[] = [];
    for (const entity of crate.entities()) {
      if (!recordType(entity)) {
        continue;
      }
      const entityId = entity['@id'];
      const rootCollection = rows.get(entityId);
      if (rootCollection === undefined) {
        log.warn({ crateId, entityId }, 'Skipped: no database row');
        continue;
      }
      const doc = await searchDocument(crate, crateObject, entity, license, rootCollection, paths.get(entityId));
      if (doc.text) {
        // Indexed alone to keep each request small
        await this.search.index([doc]);
      } else {
        docs.push(doc);
      }
    }
    for (const batch of batches(docs)) {
      await this.search.index(batch);
    }
  }
}
