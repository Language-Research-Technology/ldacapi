import type { Entity, ROCrate } from 'ro-crate';
import { config } from '../configuration.ts';
import { logger } from '../logger.ts';
import { firstStringOrId } from '../utils.ts';

const log = logger.child({ module: 'indexer' });

export type BaseOptions = {
  defaultLicense?: string;
  defaultMetadataLicense?: string;
  name?: string;
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
export type LogicalPaths = Map<string, string>;

export interface CrateFile {
  size: number;
  crc32: string;
}

export interface CrateObject {
  /** The id of the OCFL object holding the crate */
  id: string;
  /** The absolute path of the root directory of the crate */
  root: string;
  /** The text content of a file within the crate */
  text(path: string): Promise<string>;
  /** The metadata of a file within the crate, such as size */
  file(path: string): Promise<CrateFile>;
}

export class Indexer {
  defaultLicense: string;
  defaultMetadataLicense: string;
  name: string;

  constructor(opt?: BaseOptions) {
    this.defaultLicense = opt?.defaultLicense || '';
    this.defaultMetadataLicense = opt?.defaultMetadataLicense || '';
    this.name = opt?.name || Object.getPrototypeOf(this).constructor.name;
  }

  static async create<T extends Indexer, O>(this: new (opt: O) => T, opt: O) {
    const indexer = new this(opt);
    await indexer.init();
    return indexer;
  }

  deriveUniqueEntityId(crateRootId: string, entityId: string) {
    if (entityId.startsWith(crateRootId)) {
      return entityId;
    } else if (entityId.match(/.+:.+/)) {
      return entityId;
    } else {
      return `${crateRootId}/${entityId}`;
    }
  }

  /**
   * Rename each entity's @id to its unique id, returning the path in the crate of each entity that has one
   * Idempotent, as indexers share the crate
   */
  deriveUniqueEntityIds(crate: ROCrate) {
    const descriptorId = crate.descriptor['@id'];
    const prefix = `${crate.rootId}/`;
    const paths: LogicalPaths = new Map();
    for (const entity of crate.entities()) {
      const original: string = entity['@id'];
      if (original === descriptorId) {
        continue;
      }
      const id = this.deriveUniqueEntityId(crate.rootId, original);
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

  async init() {}

  async count(_crateId?: string): Promise<number> {
    throw new Error('Not Implemented');
  }

  /**
   * Delete the index for a given crateId or all index entries if a crateId is not specified.
   * All implementation of this method should ensure that when crateId is
   * null or undefined, the entire index (or all entries) is deleted.
   */
  async delete(_crateId?: string) {
    throw new Error('Not Implemented');
  }

  async index({ crateObject, crate }: { crateObject: CrateObject; crate: ROCrate }) {
    const rootDataset = crate.root;
    const crateId = crate.rootId;
    const metadataLicense = firstStringOrId(crate.descriptor.license) || this.defaultMetadataLicense;
    const license = firstStringOrId(rootDataset.license) || this.defaultLicense;
    if (!rootDataset) {
      log.warn({ path: crateObject.root }, 'Skipped: Does not contain an ROCrate with a valid root dataset');
    } else if (crateId === './') {
      log.warn({ path: crateObject.root }, "Skipped: Cannot process a crate with invalid identifier ('./')");
    } else if (!metadataLicense) {
      log.warn({ path: crateObject.root, crateId }, 'Skipped: No metadata license found');
    } else if (!license) {
      log.warn({ path: crateObject.root, crateId }, 'Skipped: No license found');
    } else {
      log.info({ crateId }, 'Indexing crate');
      const paths = this.deriveUniqueEntityIds(crate);
      try {
        await this._index({ crateObject, crate, paths, license, metadataLicense });
      } catch (error) {
        log.error({ err: error, crateId, path: crateObject.root }, 'Error indexing crate');
      }
      log.info({ crateId }, 'Indexed crate');
    }
  }

  async _index(_param: { crateObject: CrateObject; crate: ROCrate; paths: LogicalPaths; license: string; metadataLicense: string }) {
    throw new Error('Not Implemented');
  }

  /** Index a single entity within the crate. This needs to be implemented in the specific concrete indexer implementation. */
  async _indexEntity(_param: { crateObject: CrateObject; crate: ROCrate; license: string; metadataLicense: string }) {
    throw new Error('Not Implemented');
  }
}

export const RecordType: Record<string, string> = config.indexType;

/** The entity's first type that we index, if it conforms to that type's profile */
export function recordType(entity: Entity): string | undefined {
  const type = entity['@type'].find((t: string) => t in RecordType);
  const profile = type && RecordType[type];
  if (profile && !entity.conformsTo?.some((c: { '@id': string }) => c['@id'] === profile)) {
    return;
  }
  return type;
}
