import type { ROCrate } from "ro-crate";
import { config } from "../configuration.ts";
import { logger } from "../index.ts";
import { firstStringOrId } from '../utils.ts';

type BaseOptions = {
  defaultLicense?: string;
  defaultMetadataLicense?: string;
  name?: string;
};

export interface CrateFile {
  size: number;
  crc32: string;
}

export interface CrateObject {
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

  static async create(opt: any) {
    const indexer = new this(opt);
    await indexer.init();
    return indexer;
  }

  deriveUniqueEntityId(crateRootId : string, entityId: string) {
    if (entityId.startsWith(crateRootId)) return entityId;
    //else if (entityId.includes(':')) return crateRootId + '>>' + entityId;
    else if (entityId.includes(':')) return entityId;
    else return crateRootId + '/' + entityId;
  }

  async init() {}

  async _index(param: { crateObject: CrateObject, crate: ROCrate, license: string, metadataLicense: string }) {
    throw new Error('Not Implemented');
  }

  async count(crateId?: string): Promise<number> {
    throw new Error('Not Implemented');
  }

  /** 
   * Delete the index for a given crateId or all index entries if a crateId is not specified. 
   * All implementation of this method should ensure that when crateId is 
   * null or undefined, the entire index (or all entries) is deleted.
   */
  async delete(crateId?: string) {
    throw new Error('Not Implemented');
  }

  async index({ crateObject, crate }: { crateObject: CrateObject, crate: ROCrate }) {
    const rootDataset = crate.root;
    const crateId = crate.rootId;
    const metadataLicense = firstStringOrId(crate.descriptor.license) || this.defaultMetadataLicense;
    const license = firstStringOrId(rootDataset.license) || this.defaultLicense;
    const warnPrefix = `[${this.name}][${crateObject.root}]`;
    if (!rootDataset) {
      logger.warn(`${warnPrefix} Skipped: Does not contain an ROCrate with a valid root dataset.`);
    } else if (crateId === './') {
      logger.warn(`${warnPrefix} Skipped: Cannot process a crate with invalid identifier ('./').`);
    } else if (!metadataLicense) {
      logger.warn(`${warnPrefix} Skipped: No metadata license found.`);
    } else if (!license) {
      logger.warn(`${warnPrefix} Skipped: No license found.`);
    } else {
      //logger.debug('index ' + ocflObject.root);
      //console.log(this.__state);
      logger.info(`Indexing ${crateId}`);
      await this._index({ crateObject, crate, license, metadataLicense });
    }
  }

}

export const RecordType = config.indexType;
