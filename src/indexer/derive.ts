import type { GeoPoint } from 'arocapi';
import { type Entity, type RawEntity, ROCrate, Utils } from 'ro-crate';
import type { AccessControl } from '../access/access-control.ts';
import type { EntityMeta } from '../entity-meta.ts';
import { entityId, isAbsoluteIri } from '../repository/entity-id.ts';
import type { Document } from '../search-backend.ts';

/** What derivation needs besides the crate, looked up beforehand */
export type DeriveFacts = {
  /** The collections above the crate's root, each a parent crate's root, nearest first: the last is its top collection */
  parentCrates: readonly string[];
  defaultLicense: string;
  defaultMetadataLicense: string;
  isOpenLicence: (licenseId: string) => boolean;
  /** The size of each file the repository holds for the crate, by its path in the crate */
  heldFiles: ReadonlyMap<string, number>;
};

export type EntityRow = {
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
  /** Held: its size in the repository; described but not held: the leading integer of the stated `contentSize`, or 0 */
  size: number;
  /** Where the file is in the crate, when the crate holds it */
  path?: string;
};

export type DerivedEntity = {
  row: EntityRow;
  /** A person, organisation or software entity, which other crates may contain too; anything else this crate alone holds */
  shared: boolean;
  file?: FileRow;
  document: Document;
  /** The file whose text belongs in the document */
  textPath?: string;
};

/** Something odd in the crate that doesn't stop it being indexed */
type Warning = { msg: string } & Record<string, unknown>;

/** What the crate adds to Oni's aggregates for one entity: what is below it, and the values at or below it */
type Aggregate = {
  entityId: string;
  collections: number;
  objects: number;
  subCollections: number;
  files: number;
  language: string[];
  communicationMode: string[];
  mediaType: string[];
};

export type Derivation = {
  crateId: string;
  name: string | null;
  /** Whether the crate's metadata licence is open, so its copy of a shared entity wins over a restricted one */
  openMetadata: boolean;
  entities: DerivedEntity[];
  aggregates: Aggregate[];
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

/** Types of shared entities, whose root collection is always null */
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

/** The leading integer of a schema.org contentSize, which is text such as "14384 bytes", or 0 */
function statedSize(contentSize: unknown) {
  const size = Number.parseInt(String(contentSize), 10);
  return Number.isNaN(size) ? 0 : size;
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

/** An entity as plain JSON-LD, every value but its id an array */
function asArrays(entity: Entity): RawEntity {
  return Object.fromEntries(Object.entries(entity.toJSON()).map(([key, value]) => [key, key === '@id' ? value : Utils.asArray(value)])) as RawEntity;
}

const STUB_KEYS = ['@id', '@type', 'name', 'description'];

/** A linked record as a virtual crate holds it: enough to show it, and the id to fetch the rest by */
function stub(entity: Entity) {
  const json = asArrays(entity);
  const keys = isFile(entity) ? [...STUB_KEYS, 'filename'] : STUB_KEYS;
  return Object.fromEntries(keys.filter((key) => key in json).map((key) => [key, json[key]])) as RawEntity;
}

/** What every virtual crate of one crate draws on */
type Source = {
  crate: ROCrate;
  /** The crate root's `conformsTo`, as references */
  conformsTo: unknown[];
  /** The crate's content licence */
  license: string;
  /** How an entity appears in the virtual crate of one that links to it: a stub if it's a record, else a copy */
  linkedForm: (entity: Entity) => RawEntity;
};

/** The source of a crate's virtual crates, each linked entity's form made once however many entities link to it */
function sourceOf(crate: ROCrate, license: string): Source {
  const made = new Map<string, RawEntity>();
  const linkedForm = (entity: Entity) => {
    let form = made.get(entity['@id']);
    if (!form) {
      form = recordType(entity) ? stub(entity) : asArrays(entity);
      made.set(entity['@id'], form);
    }
    return form;
  };
  return { crate, conformsTo: Utils.asArray(crate.root.toJSON().conformsTo), license, linkedForm };
}

/** The entities in the crate that `values` link to, other than `selfId` and the crate's descriptor */
function linkedEntities(crate: ROCrate, selfId: string, values: unknown[]) {
  const found = new Map<string, Entity>();
  for (const value of values) {
    const linkedId = (value as { '@id'?: unknown })?.['@id'];
    const linked = typeof linkedId === 'string' && linkedId !== selfId && linkedId !== crate.descriptor['@id'] && crate.getEntity(linkedId);
    if (linked) {
      found.set(linkedId, linked);
    }
  }
  return [...found.values()];
}

/**
 * What the virtual crate of `entity` holds besides it: everything it links to, directly or through entities that aren't
 * records. A record is held as a stub, and what it links to is left out
 */
function reachable({ crate, linkedForm }: Source, entity: RawEntity) {
  const selfId = entity['@id'];
  const held = new Map<string, RawEntity>();
  const toFollow = [entity];
  for (const at of toFollow) {
    for (const linked of linkedEntities(crate, selfId, Object.values(at).flat())) {
      if (!held.has(linked['@id'])) {
        const form = linkedForm(linked);
        held.set(linked['@id'], form);
        if (!recordType(linked)) {
          toFollow.push(form);
        }
      }
    }
  }
  return held.values();
}

/** The virtual crate: a new crate with the entity, under its indexed id, as its root, and what it reaches up to records */
function virtualCrate(source: Source, entity: Entity, id: string, hidden: boolean) {
  const newCrate = new ROCrate({ '@context': source.crate['@context'] }, { array: true, duplicate: true });
  const json = asArrays(entity);
  for (const [key, value] of Object.entries(json)) {
    if (key !== '@id') {
      newCrate.root[key] = value;
    }
  }
  for (const linked of reachable(source, json)) {
    newCrate.addEntity(linked);
  }
  newCrate.rootId = id;
  if (!entity['@type'].includes('Dataset')) {
    newCrate.root['@type'].push('Dataset');
  }
  if (!entity.conformsTo) {
    newCrate.root.conformsTo = source.conformsTo;
  }
  if (!entity.license) {
    newCrate.root.license = source.license;
  }
  if (hidden) {
    newCrate.root.display = false;
  }
  return newCrate.toJSON();
}

/** Every entity row, file row and search document a crate gives, by the derivation rules */
export function derive(crate: ROCrate, facts: DeriveFacts): Derivation {
  const crateId = crate.rootId;
  if (!isAbsoluteIri(crateId)) {
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

  const topCollection = facts.parentCrates.at(-1) ?? crateId;
  const source = sourceOf(crate, crateLicense);
  const warnings: Warning[] = [];
  const entities: DerivedEntity[] = [];
  const prefix = `${crateId}/`;
  const placed: Placed[] = [];
  let notHeld = 0;
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
    const rootCollection = UNPLACED.has(type) || id === topCollection ? null : topCollection;
    const contentLicenseId = contentLicense(entity);
    const accessControl: AccessControl = facts.isOpenLicence(contentLicenseId) ? 'Public' : 'AuthorizationByApplication';
    const entityType: string = crate.getContextDefinition(type) || PROFILES[type];
    const name = entity.name?.join('; ') || id;
    const [datePublished] = dates(entity, 'datePublished');
    const point = location(entity);
    const language = labels(entity, 'inLanguage');
    const communicationMode = labels(entity, 'ldac:communicationMode');
    const mediaType = labels(entity, 'encodingFormat');
    if (!UNPLACED.has(type)) {
      placed.push({ id, counted: COUNTED[type] as Counted, memberOf, values: { language, communicationMode, mediaType } });
    }
    const cratePath = (id.startsWith(prefix) && crateRelativePath(id.slice(prefix.length))) || undefined;
    const heldSize = cratePath === undefined ? undefined : facts.heldFiles.get(cratePath);
    const path = heldSize === undefined ? undefined : cratePath;
    const unheldFile = type === 'File' && path === undefined;
    if (unheldFile) {
      notHeld++;
    }
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
        meta: { rocrate: virtualCrate(source, entity, id, unheldFile), accessControl },
      },
      shared: UNPLACED.has(type),
      ...(type === 'File' && {
        file: {
          id,
          filename: (cratePath ?? id).split('/').pop() as string,
          mediaType: entity.encodingFormat?.find((v: unknown) => typeof v === 'string') || 'application/octet-stream',
          size: heldSize ?? statedSize(entity.contentSize?.[0]),
          ...(path && { path }),
        },
      }),
      document: {
        id,
        name,
        description: labels(entity, 'description'),
        entityType,
        recordType: classLabel(entityType),
        inLanguage: language,
        communicationMode,
        linguisticGenre: labels(entity, 'ldac:linguisticGenre'),
        annotationType: labels(entity, 'ldac:annotationType'),
        encodingFormat: mediaType,
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
  if (notHeld > 0) {
    warnings.push({ msg: 'Files described but not held', count: notHeld });
  }
  return {
    crateId,
    name: firstStringOrId(crate.root.name) ?? null,
    openMetadata: facts.isOpenLicence(metadataLicense),
    entities,
    aggregates: aggregates(placed, facts.parentCrates),
    warnings,
  };
}

type Counted = 'collections' | 'objects' | 'files';

type Listed = 'language' | 'communicationMode' | 'mediaType';

const COUNTED: Record<string, Counted> = { RepositoryCollection: 'collections', RepositoryObject: 'objects', File: 'files' };

/** A collection, object or file, as aggregates need it */
type Placed = { id: string; counted: Counted; memberOf: string | null; values: Record<Listed, string[]> };

type Totals = { counts: Record<Counted | 'subCollections', number>; lists: Record<Listed, Set<string>> };

/**
 * What the crate adds below each of its collections, objects and files, and below the ancestors it names outside
 * itself, following each entity's parent up through the parent crates
 */
function aggregates(placed: Placed[], parentCrates: readonly string[]): Aggregate[] {
  const parents = new Map<string, string | null>(parentCrates.map((id, i) => [id, parentCrates[i + 1] ?? null]));
  for (const { id, memberOf } of placed) {
    parents.set(id, memberOf);
  }
  const totals = new Map<string, Totals>();
  const totalsOf = (id: string) => {
    let found = totals.get(id);
    if (!found) {
      found = {
        counts: { collections: 0, objects: 0, subCollections: 0, files: 0 },
        lists: { language: new Set(), communicationMode: new Set(), mediaType: new Set() },
      };
      totals.set(id, found);
    }
    return found;
  };
  for (const { id, counted, memberOf, values } of placed) {
    const seen = new Set<string>();
    for (let at: string | null | undefined = id; at && !seen.has(at); at = parents.get(at)) {
      seen.add(at);
      const { counts, lists } = totalsOf(at);
      if (at !== id) {
        counts[counted]++;
        if (counted === 'collections' && at === memberOf) {
          counts.subCollections++;
        }
      }
      for (const listed of ['language', 'communicationMode', 'mediaType'] as const) {
        for (const value of values[listed]) {
          lists[listed].add(value);
        }
      }
    }
  }
  const sorted = (values: Set<string>) => [...values].sort();
  return [...totals].map(([entityId, { counts, lists }]) => ({
    entityId,
    ...counts,
    language: sorted(lists.language),
    communicationMode: sorted(lists.communicationMode),
    mediaType: sorted(lists.mediaType),
  }));
}
