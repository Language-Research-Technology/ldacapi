import { logger } from "../index.ts";
import type { OcflObject } from "@ocfl/ocfl";
import type { ROCrate } from "ro-crate";

type BaseOptions = {
  defaultLicense?: string;
  defaultMetadataLicense?: string;
};

export interface CrateObject {
  root: string;
  text(path: string): Promise<string>;
}

export class Indexer {
  defaultLicense: string;
  defaultMetadataLicense: string;

  constructor(opt?: BaseOptions) {
    this.defaultLicense = opt?.defaultLicense || '';
    this.defaultMetadataLicense = opt?.defaultMetadataLicense || '';
  }

  static async create(opt: any) {
    const indexer = new this(opt);
    await indexer.init();
    return indexer;
  }

  async init() {}

  async _index(param: { crateObject: CrateObject, crate: ROCrate }) {
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
    const license = rootDataset.license?.[0]?.['@id'] || this.defaultLicense;
    if (!rootDataset) {
      logger.warn(`${crateObject.root}: Skipped: Does not contain an ROCrate with a valid root dataset.`);
    } else if (crateId === './') {
      logger.warn(`${crateObject.root}: Skipped: Cannot process a crate with invalid identifier ('./').`);
    } else if (!license) {
      logger.warn(`${crateObject.root}: Skipped: No license found.`);
    } else {
      //logger.debug('index ' + ocflObject.root);
      //console.log(this.__state);
      await this._index({ crateObject, crate });
    }
  }

}

export const RecordType = {
  RepositoryCollection: 'https://w3id.org/ldac/profile#Collection',
  RepositoryObject: 'https://w3id.org/ldac/profile#Object',
  File: 'https://schema.org/MediaObject'
};
