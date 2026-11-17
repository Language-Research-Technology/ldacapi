import type { Entity, ROCrate } from 'ro-crate';
import { config } from '../configuration.ts';
import { firstStringOrId } from '../utils.ts';

export type Licences = {
  defaultLicense: string;
  defaultMetadataLicense: string;
};

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

/** Entity id → its path in the crate */
type LogicalPaths = Map<string, string>;

export interface CrateFile {
  size: number;
}

export interface CrateObject {
  /** The id of the OCFL object holding the crate */
  id: string;
  /** The text content of a file within the crate */
  text(path: string): Promise<string>;
  /** The metadata of a file within the crate, such as size */
  file(path: string): Promise<CrateFile>;
}

export type WriteParams = {
  crateObject: CrateObject;
  crate: ROCrate;
  paths: LogicalPaths;
  license: string;
  metadataLicense: string;
  topCollection: string;
};

const deriveUniqueEntityId = (crateRootId: string, entityId: string) => {
  if (entityId.startsWith(crateRootId)) {
    return entityId;
  } else if (entityId.match(/.+:.+/)) {
    return entityId;
  } else {
    return `${crateRootId}/${entityId}`;
  }
};

/**
 * Rename each entity's @id to its unique id, returning the path in the crate of each entity that has one
 * Idempotent, as writers share the crate
 */
export function deriveUniqueEntityIds(crate: ROCrate) {
  const descriptorId = crate.descriptor['@id'];
  const prefix = `${crate.rootId}/`;
  const paths: LogicalPaths = new Map();
  for (const entity of crate.entities()) {
    const original: string = entity['@id'];
    if (original === descriptorId) {
      continue;
    }
    const id = deriveUniqueEntityId(crate.rootId, original);
    const path = id.startsWith(prefix) && crateRelativePath(id.slice(prefix.length));
    if (path) {
      paths.set(id, path);
    }
    if (id !== original) {
      entity['@id'] = id;
    }
  }
  return paths;
}

/** What the rows and documents writers share */
export abstract class Writer {
  defaultLicense: string;
  defaultMetadataLicense: string;

  constructor(licences: Licences) {
    this.defaultLicense = licences.defaultLicense;
    this.defaultMetadataLicense = licences.defaultMetadataLicense;
  }

  /** `topCollection` is the top-level collection the crate sits under, the crate's own root if it has no parent */
  async index({ crateObject, crate, topCollection }: { crateObject: CrateObject; crate: ROCrate; topCollection: string }) {
    const metadataLicense = firstStringOrId(crate.descriptor.license) || this.defaultMetadataLicense;
    const license = firstStringOrId(crate.root.license) || this.defaultLicense;
    if (!metadataLicense || !license) {
      throw new Error(`The crate has no ${metadataLicense ? 'licence' : 'metadata licence'}, and none is configured as the default`);
    }
    const paths = deriveUniqueEntityIds(crate);
    await this.write({ crateObject, crate, paths, license, metadataLicense, topCollection });
  }

  abstract write(params: WriteParams): Promise<void>;

  /** Removes what this writer wrote for `crateId` */
  abstract delete(crateId: string): Promise<void>;
}

/** An entity's rootCollection: empty on the top-level collection itself */
export const rootCollection = (topCollection: string, entityId: string) => (entityId === topCollection ? null : topCollection);

/** The first collection `entity` is a member of, by `pcdm:memberOf` or `memberOf`, in a parsed crate or raw JSON-LD */
export const memberOf = (entity: Record<string, unknown>) => firstStringOrId(entity['pcdm:memberOf']) || firstStringOrId(entity.memberOf);

/** The id of the collection a crate's root is a member of, if any */
export function parentCollection(root: Record<string, unknown>, rootId: string): string | undefined {
  const parent = memberOf(root);
  return parent && parent !== rootId ? parent : undefined;
}

const RecordType: Record<string, string> = config.indexType;

/** The entity's first type that we index, if it conforms to that type's profile */
export function recordType(entity: Entity): string | undefined {
  const type = entity['@type'].find((t: string) => t in RecordType);
  const profile = type && RecordType[type];
  if (profile && !entity.conformsTo?.some((c: { '@id': string }) => c['@id'] === profile)) {
    return;
  }
  return type;
}

/** The class URI of a record type, as the entity's row holds it */
export const entityClass = (crate: ROCrate, type: string): string => crate.getContextDefinition(type) || RecordType[type];
