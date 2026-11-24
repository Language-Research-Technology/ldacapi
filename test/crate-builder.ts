import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type JsonLd = Record<string, unknown> & { '@id': string };

/**
 * An entity stated for a crate, with the bytes behind it when it is a file the crate holds.
 * `licence` is the licence option as given, so `crate` can tell "none" (null) from "not stated"
 */
export type Part = { entity: JsonLd; content?: string | Uint8Array; licence?: string | null };

/** A crate ready to write: its metadata, and the content of each file it holds by path */
export type Crate = { id: string; metadata: { '@context': unknown; '@graph': JsonLd[] }; files: Map<string, string | Uint8Array> };

const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';

const CONTEXT = ['https://w3id.org/ro/crate/1.1/context', 'https://w3id.org/ldac/context', { '@vocab': 'http://schema.org/' }];

/** Any other properties of an entity, as JSON-LD */
type Properties = Record<string, unknown>;

/** `licence` is a licence id; null states no licence */
type Licensed = { licence?: string | null };

type MemberOptions = { name?: string; memberOf?: string; hasMember?: string[]; hasPart?: string[] } & Licensed & Properties;

type FileOptions = { isPartOf?: string } & Licensed & Properties;

const ref = (id: string) => ({ '@id': id });

const licensed = (entity: JsonLd, licence: string | null | undefined): Part => ({
  entity: licence ? { ...entity, license: ref(licence) } : entity,
  ...(licence !== undefined && { licence }),
});

const member = (id: string, type: string, profile: string, { name = id, memberOf, hasMember, hasPart, licence, ...properties }: MemberOptions) =>
  licensed(
    {
      '@id': id,
      '@type': ['Dataset', type],
      conformsTo: ref(`https://w3id.org/ldac/profile#${profile}`),
      name,
      ...(memberOf && { 'pcdm:memberOf': ref(memberOf) }),
      ...(hasMember && { 'pcdm:hasMember': hasMember.map(ref) }),
      ...(hasPart && { hasPart: hasPart.map(ref) }),
      ...properties,
    },
    licence,
  );

/** A collection, linked to its parent by `pcdm:memberOf` and to its members by `pcdm:hasMember` */
export const collection = (id: string, options: MemberOptions = {}) => member(id, 'RepositoryCollection', 'Collection', options);

/** An object, linked to its collection by `pcdm:memberOf` and to its files by `hasPart` */
export const object = (id: string, options: MemberOptions = {}) => member(id, 'RepositoryObject', 'Object', options);

const fileEntity = (path: string, { isPartOf, licence, ...properties }: FileOptions) =>
  licensed({ '@id': path, '@type': 'File', ...(isPartOf && { isPartOf: ref(isPartOf) }), ...properties }, licence);

/** A file the crate holds, with `content` as its bytes */
export const file = (path: string, { content, ...options }: { content: string | Uint8Array } & FileOptions): Part => ({
  ...fileEntity(path, options),
  content,
});

/** A file the crate describes but holds no bytes for */
export const fileDescribedButNotHeld = (path: string, options: FileOptions = {}) => fileEntity(path, options);

export const person = (id: string, properties: Properties = {}): Part => ({
  entity: { '@id': id, '@type': 'Person', conformsTo: ref('https://w3id.org/ldac/profile#Person'), ...properties },
});

/** A licence described in full; any licence used but not stated this way gets a bare description */
export const licence = (id: string, properties: Properties = {}): Part => ({ entity: { '@id': id, '@type': 'CreativeWork', ...properties } });

/**
 * A crate of `root` and `parts`. The root's licence and the metadata licence default to CC BY 4.0
 */
/** A crate of `root` and `parts`, its metadata under `metadataLicence`, or none when null */
export const crate = (root: Part, parts: Part[] = [], { metadataLicence = CC_BY }: { metadataLicence?: string | null } = {}): Crate => {
  const id = root.entity['@id'];
  const descriptor = {
    '@id': 'ro-crate-metadata.json',
    '@type': 'CreativeWork',
    about: ref(id),
    ...(metadataLicence !== null && { license: ref(metadataLicence) }),
  };
  const rootEntity = licensed(root.entity, root.licence === undefined ? CC_BY : root.licence).entity;
  const entities = [descriptor, rootEntity, ...parts.map(({ entity }) => entity)];
  const stated = new Set(entities.map((entity) => entity['@id']));
  const licences = new Set(entities.flatMap(({ license }) => (license ? [(license as { '@id': string })['@id']] : [])));
  const undescribed = [...licences].filter((licenceId) => !stated.has(licenceId)).map((licenceId) => licence(licenceId, { name: licenceId }).entity);

  const files = new Map<string, string | Uint8Array>();
  for (const { entity, content } of parts) {
    if (content !== undefined) {
      files.set(entity['@id'], content);
    }
  }
  return { id, metadata: { '@context': CONTEXT, '@graph': [...entities, ...undescribed] }, files };
};

/** Writes `crate` into `folder`, as `crates:import` reads it */
export const writeCrateAt = async (folder: string, { metadata, files }: Crate) => {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'ro-crate-metadata.json'), JSON.stringify(metadata, null, 2));
  for (const [path, content] of files) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), content);
  }
};

/** Writes each crate into its own folder under `directory`, as `crates:import` reads them */
export const writeCrates = async (directory: string, crates: Crate[]) => {
  for (const crate of crates) {
    await writeCrateAt(join(directory, crate.id.replace(/[^A-Za-z0-9]+/g, '_')), crate);
  }
};
