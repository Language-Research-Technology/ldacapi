import { logger, prisma } from "../index.ts";
import { Indexer, RecordType } from "./indexer.ts";
import { join, relative } from "node:path";

import type { OcflObject } from "@ocfl/ocfl";
import { ROCrate } from "ro-crate";

export class StructuralIndexer extends Indexer {
  ocflPath: string;
  ocflPathInternal: string;
  memberOfField: string;

  constructor(opt: any) {
    super(opt);
    this.ocflPath = opt.ocflPath;
    this.ocflPathInternal = opt.ocflPathInternal
    this.memberOfField = opt.memberOfField || 'pcdm:memberOf';
  }

  async _index({ ocflObject, crate }: { ocflObject: OcflObject, crate: ROCrate }) {
    await ocflObject.load();
    const rootDataset = crate.root;
    const crateId = crate.rootId;
    const license = rootDataset.license?.[0]?.['@id'] || this.defaultLicense;
    //console.log(`${crateId} license: ${lic}`);
    const objectRoot = ocflObject.root;
    logger.info(`[structural] Indexing ${crateId}`);
    let count = 0;
    for (const entity of crate.entities()) {
      for (const t of entity['@type']) {
        if (t in RecordType) {
          const entityType = crate.getContextDefinition(t);
          //const entityType = RecordType[t as keyof typeof RecordType];
          logger.debug(`[structural] Indexing ${crateId} ${entity['@id']}`);
          count++;
          await prisma.entity.create({
            data: {
              rocrateId: entity['@id'],
              name: entity.name?.join('; ') || '',
              description: entity.description?.join('; ') || '',
              entityType,
              memberOf: entity['pcdm:memberOf']?.[0]['@id'] || entity.memberOf?.[0]['@id'] || entity['@reverse'].hasMember?.[0]?.['@id'] || null,
              rootCollection: crate.rootId,
              metadataLicenseId: crate.metadata?.license?.[0]['@id'] || '',
              contentLicenseId: entity.license[0]['@id'] || license,
              rocrate: entityAsCrate(crate, entity)
            }
          });
        }
      }
    }
    // const rec = {
    //   crateId,
    //   license,
    //   name: rootDataset.name?.[0] || crateId,
    //   description: rootDataset.description?.[0] || '',
    //   objectRoot
    // }
    // await createRecord({
    //   data: rec,
    //   memberOfs: rootDataset[this.memberOfField] || [],
    //   atTypes: rootDataset['@type'] || [],
    //   conformsTos: rootDataset.conformsTo || []
    // });
    // await File.destroy({ where: { crateId } });
    // const relRoot = relative(this.ocflPath, objectRoot);
    // let count = 0;
    // for await (let f of await ocflObject.files()) {
    //   try {
    //     await File.create({
    //       path: join(relRoot, f.contentPath),
    //       logicalPath: f.logicalPath,
    //       crateId,
    //       size: f.size,
    //       crc32: hash,
    //       lastModified: f.lastModified
    //     });
    //     logger.debug(`[structural] [${rec.crateId}] Indexed file ${f.logicalPath}`);
    //     count++;
    //   } catch (error) {
    //     logger.error(error.message);
    //   }
    // }

    logger.info(`[structural] Indexed ${crateId}: entities=${count}`);
  }

  async delete(crateId?: string) {
    const where = crateId ? { rocrateId: { startsWith: crateId } } : {};
    //const truncate = !crateId;
    await prisma.entity.deleteMany({ where });
    //await File.destroy({ truncate, where });
  }

  async count(crateId?: string) {
    let opt;
    if (crateId) {
      opt = {
        where: { rocrateId: crateId },
      }
    }
    return await prisma.entity.count(opt);
  }
}


function entityAsCrate(crate: ROCrate, entity: any) {
  const newCrate = new ROCrate({ array: true, link: true });
  for (const key in entity) {
    newCrate.root[key] = entity[key];
  }
  newCrate.root["@type"].push("Dataset");
  if (!entity.conformsTo) {
    newCrate.root.conformsTo = crate.root.conformsTo;
  }
  return newCrate.toJSON();
}
