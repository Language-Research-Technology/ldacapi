import type { GeoPoint } from 'arocapi';
import { type Entity, ROCrate } from 'ro-crate';
import type { AccessControl } from '../access/access-control.ts';
import type { EntityMeta } from '../entity-meta.ts';
import { entityId } from '../repository/entity-id.ts';
import type { Document } from '../search-backend.ts';

/** What derivation needs besides the crate, looked up beforehand */
export type DeriveFacts = {
  /** The top-level collection the crate sits under, found from its parent crates; the crate's own root if it has none */
  topCollection: string;
  defaultLicense: string;
  defaultMetadataLicense: string;
  isOpenLicence: (licenseId: string) => boolean;
};

type EntityRow = {
  id: string;
  name: string;
  description: string;
  entityType: string;
  memberOf: string | null;
  rootCollection: string | null;
  metadataLicenseId: string;
  contentLicenseId: string;
  meta: EntityMeta;
};

type FileRow = {
  id: string;
  filename: string;
  mediaType: string;
  /** The leading integer of the stated `contentSize`, or -1 */
  statedSize: number;
  /** Where the file is in the crate, when its id is under the crate root */
  path?: string;
};

export type DerivedEntity = {
  row: EntityRow;
  file?: FileRow;
  document: Document;
  /** The file whose text belongs in the document */
  textPath?: string;
};

/** Something odd in the crate that doesn't stop it being indexed */
type Warning = { msg: string } & Record<string, unknown>;

export type Derivation = {
  crateId: string;
  name: string | null;
  entities: DerivedEntity[];
  warnings: Warning[];
};

/** The LDaC profile each indexed type must conform to; a File needs none */
const PROFILES: Record<string, string> = {
  RepositoryCollection: 'https://w3id.org/ldac/profile#Collection',
  RepositoryObject: 'https://w3id.org/ldac/profile#Object',
  File: '',
  Person: 'https://w3id.org/ldac/profile#Person',
  Organization: 'https://w3id.org/ldac/profile#Organization',
  SoftwareApplication: 'https://w3id.org/ldac/profile#SoftwareApplication',
};

/** Types whose root collection is always null */
const UNPLACED = new Set(['Person', 'Organization', 'SoftwareApplication']);

const CLASS_LABELS: Record<string, string> = {
  'http://pcdm.org/models#Collection': 'Collection',
  'http://pcdm.org/models#Object': 'Object',
  'http://schema.org/MediaObject': 'File',
  'http://schema.org/Person': 'Person',
  'http://schema.org/Organization': 'Organisation',
  'http://schema.org/SoftwareApplication': 'Software Application',
};

/** The first string or `@id` of a JSON-LD value, which may be a single value or an array */
function firstStringOrId(values: unknown): string | undefined {
  for (const value of [values ?? []].flat()) {
    if (typeof value === 'string') {
      return value;
    } else if (typeof value === 'object' && value !== null && '@id' in value && typeof value['@id'] === 'string') {
      return value['@id'];
    }
  }
}

/** The entity's first type that we index, if it conforms to that type's profile */
function recordType(entity: Entity): string | undefined {
  const type = entity['@type'].find((t: string) => t in PROFILES);
  const profile = type && PROFILES[type];
  if (profile && !entity.conformsTo?.some((c: unknown) => firstStringOrId(c) === profile)) {
    return;
  }
  return type;
}

/** A readable label for a class URI, either schema.org scheme alike, falling back to its last segment */
const classLabel = (uri: string) =>
  CLASS_LABELS[uri.replace(/^https:\/\/schema\.org\//, 'http://schema.org/')] ?? uri.slice(Math.max(uri.lastIndexOf('#'), uri.lastIndexOf('/')) + 1);

/** Linked entities by name, falling back to their id; literals as they are */
const labels = (entity: Entity, property: string) => {
  const found = ((entity[property] ?? []) as unknown[]).map((value) => {
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
const dates = (entity: Entity, property: string) =>
  labels(entity, property)
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
  for (const place of [...(entity.contentLocation ?? []), ...(entity.spatialCoverage ?? [])]) {
    const point = typeof place === 'object' && place !== null ? pointOf(place as Record<string, unknown[] | undefined>) : undefined;
    if (point) {
      return point;
    }
  }
}

const isText = (entity: Entity) => entity.encodingFormat?.some((format: unknown) => typeof format === 'string' && format.startsWith('text/'));

/** A URI reference relative to the crate root as a decoded path, dropping any query or fragment */
function crateRelativePath(ref: string) {
  const path = new URL(ref, 'file:///').pathname.slice(1);
  if (!path) {
    return;
  }
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** The leading integer of a schema.org contentSize, which is text such as "14384 bytes", or -1 */
function statedSize(contentSize: unknown) {
  const size = Number.parseInt(String(contentSize), 10);
  return Number.isNaN(size) ? -1 : size;
}

const typed = (entity: Entity, type: string) => (entity['@type'] as string[]).includes(type);

const isFile = (entity: Entity) => typed(entity, 'File');

const isMember = (entity: Entity) => typed(entity, 'RepositoryCollection') || typed(entity, 'RepositoryObject');

/**
 * The entity's candidate parents, as raw ids: a collection or object's by `pcdm:memberOf`, else reverse `pcdm:hasMember`;
 * a file's by `isPartOf` or reverse `hasPart`, objects first. Others have none
 */
function parentCandidates(entity: Entity): string[] {
  const ids = (entities: Entity[]) => entities.map((e) => firstStringOrId(e)).filter((id): id is string => !!id);
  if (isFile(entity)) {
    const linked: Entity[] = [...(entity.isPartOf ?? []), ...entity['@reverse'].hasPart];
    const objects = linked.filter((e) => e['@type']?.includes('RepositoryObject'));
    return [...new Set(ids(objects.length > 0 ? objects : linked))];
  }
  if (isMember(entity)) {
    const memberOf = ids(entity['pcdm:memberOf'] ?? []);
    return [...new Set(memberOf.length > 0 ? memberOf : ids(entity['@reverse']['pcdm:hasMember']))];
  }
  return [];
}

/** The collection a crate's root is a member of, if any other */
export function parentCollection(crate: ROCrate): string | undefined {
  const [parent] = parentCandidates(crate.root).map((id) => entityId(crate.rootId, id));
  return parent && parent !== crate.rootId ? parent : undefined;
}

/** The virtual crate: a new crate with the entity, under its indexed id, as its root */
function virtualCrate(crate: ROCrate, entity: Entity, id: string, license: string) {
  const newCrate = new ROCrate({ '@context': crate['@context'] }, { array: true, link: true });
  for (const key in entity) {
    if (key !== '@id') {
      newCrate.root[key] = entity[key];
    }
  }
  newCrate.rootId = id;
  newCrate.root['@type'].push('Dataset');
  if (!entity.conformsTo) {
    newCrate.root.conformsTo = crate.root.conformsTo;
  }
  if (!entity.license) {
    newCrate.root.license = license;
  }
  return newCrate.toJSON();
}

/** Every entity row, file row and search document a crate gives, by the derivation rules */
export function derive(crate: ROCrate, facts: DeriveFacts): Derivation {
  const crateId = crate.rootId;
  if (entityId(crateId, crateId) !== crateId) {
    throw new Error(`The crate's root id, ${crateId}, isn't an absolute IRI`);
  }
  const metadataLicense = firstStringOrId(crate.descriptor.license) || facts.defaultMetadataLicense;
  const crateLicense = firstStringOrId(crate.root.license) || facts.defaultLicense;
  if (!metadataLicense || !crateLicense) {
    throw new Error(`The crate has no ${metadataLicense ? 'licence' : 'metadata licence'}, and none is configured as the default`);
  }
  const idOf = (rawId: string) => entityId(crateId, rawId);
  const descriptorId = crate.descriptor['@id'];
  const byId = new Map<string, Entity>();
  for (const entity of crate.entities()) {
    if (entity['@id'] !== descriptorId) {
      byId.set(idOf(entity['@id']), entity);
    }
  }

  const contentLicense = (entity: Entity) => {
    const seen = new Set<Entity>();
    for (let at: Entity | undefined = entity; at && !seen.has(at); at = byId.get(idOf(parentCandidates(at)[0] ?? ''))) {
      seen.add(at);
      const own = firstStringOrId(at.license);
      if (own) {
        return own;
      }
    }
    return crateLicense;
  };

  const warnings: Warning[] = [];
  const entities: DerivedEntity[] = [];
  const prefix = `${crateId}/`;
  for (const [id, entity] of byId) {
    const type = recordType(entity);
    if (!type) {
      continue;
    }
    const parents = parentCandidates(entity).map(idOf);
    if (parents.length > 1) {
      warnings.push({ msg: 'Several candidate parents; using the first', entityId: id, parents });
    }
    const memberOf = parents[0] ?? null;
    const rootCollection = UNPLACED.has(type) || id === facts.topCollection ? null : facts.topCollection;
    const contentLicenseId = contentLicense(entity);
    const accessControl: AccessControl = facts.isOpenLicence(contentLicenseId) ? 'Public' : 'AuthorizationByApplication';
    const entityType: string = crate.getContextDefinition(type) || PROFILES[type];
    const name = entity.name?.join('; ') || id;
    const [datePublished] = dates(entity, 'datePublished');
    const point = location(entity);
    const path = (id.startsWith(prefix) && crateRelativePath(id.slice(prefix.length))) || undefined;
    entities.push({
      row: {
        id,
        name,
        description: entity.description?.join('; ') || '',
        entityType,
        memberOf,
        rootCollection,
        metadataLicenseId: metadataLicense,
        contentLicenseId,
        meta: { crateId, rocrate: virtualCrate(crate, entity, id, crateLicense), accessControl },
      },
      ...(type === 'File' && {
        file: {
          id,
          filename: (path ?? id).split('/').pop() as string,
          mediaType: entity.encodingFormat?.find((v: unknown) => typeof v === 'string') || 'application/octet-stream',
          statedSize: statedSize(entity.contentSize?.[0]),
          ...(path && { path }),
        },
      }),
      document: {
        id,
        name,
        description: labels(entity, 'description'),
        entityType,
        recordType: classLabel(entityType),
        inLanguage: labels(entity, 'inLanguage'),
        communicationMode: labels(entity, 'ldac:communicationMode'),
        linguisticGenre: labels(entity, 'ldac:linguisticGenre'),
        annotationType: labels(entity, 'ldac:annotationType'),
        encodingFormat: labels(entity, 'encodingFormat'),
        ...(rootCollection && { rootCollection }),
        ...(memberOf && { memberOf }),
        license: contentLicenseId,
        ...(datePublished && { datePublished }),
        dateCreated: dates(entity, 'dateCreated'),
        temporalCoverage: dates(entity, 'temporalCoverage'),
        ...(point && { location: point }),
      },
      ...(path && isText(entity) && { textPath: path }),
    });
  }
  return { crateId, name: firstStringOrId(crate.root.name) ?? null, entities, warnings };
}
