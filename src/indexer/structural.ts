import { ROCrate } from 'ro-crate';
import { logger, prisma } from '../index.ts';
import { PromiseQueue } from '../utils.ts';
import type { CrateObject } from './indexer.ts';
import { Indexer, RecordType } from './indexer.ts';

export class StructuralIndexer extends Indexer {
  ocflPath: string;
  ocflPathInternal: string;
  memberOfField: string;

  constructor(opt: any) {
    super(opt);
    this.ocflPath = opt.ocflPath;
    this.ocflPathInternal = opt.ocflPathInternal;
    this.memberOfField = opt.memberOfField || 'pcdm:memberOf';
  }

  async _index({ crateObject, crate }: { crateObject: CrateObject; crate: ROCrate }) {
    //await ocflObject.load();
    const rootDataset = crate.root;
    const crateId = crate.rootId;
    const license = rootDataset.license?.[0]?.['@id'] || this.defaultLicense;
    //console.log(`${crateId} license: ${lic}`);
    //const objectRoot = ocflObject.root;
    logger.info(`[structural] Indexing ${crateId}`);
    let count = 0;
    const pq = new PromiseQueue(4, async (opt: Record<string, unknown>) => {
      for (const tableName in opt) {
        await prisma[tableName].create({ data: opt[tableName] });
      }
    });
    for (const entity of crate.entities()) {
      const entityType = entity['@type'].find((t) => t in RecordType); // only the first matching entity type is used
      if (!entityType) {
        continue;
      }
      const conformsTo = entity['conformsTo']?.find((c) => c['@id'] === RecordType[entityType]);
      if(!conformsTo) {
        continue;
      }
      logger.debug(`[structural] Indexing ${crateId} ${entity['@id']}`);
      count++;
      const entityId = this.deriveUniqueEntityId(crateId, entity['@id']);
      const rocrate = entityAsCrate(crate, entity);
      const param = {
        entity: {
          id: entityId,
          name: entity.name?.join('; ') || entityId,
          description: entity.description?.join('; ') || '',
          entityType: crate.getContextDefinition(entityType) || RecordType[entityType as keyof typeof RecordType],
          memberOf:
            entity['pcdm:memberOf']?.[0]['@id'] ||
            entity.memberOf?.[0]['@id'] ||
            entity['@reverse']['pcdm:hasMember']?.[0]?.['@id'] ||
            entity['@reverse'].hasMember?.[0]?.['@id'] ||
            entity.isPartOf?.find((e) => e['@type'].includes('RepositoryObject'))?.['@id'] ||
            entity['@reverse'].hasPart?.find((e) => e['@type'].includes('RepositoryObject'))?.['@id'] ||
            null,
          rootCollection: crate.rootId,
          metadataLicenseId: crate.metadata?.license?.[0]['@id'] || '',
          contentLicenseId: entity.license?.[0]['@id'] || license,
          meta: { rocrate },
        },
        ...((entityType.startsWith('://schema.org/MediaObject') || entityType === 'File') && {
          file: {
            id: entityId,
            filename: entity['@id'].split('/').pop(),
            mediaType: (entity.encodingFormat?.[0] as string) || 'application/octet-stream',
            size: BigInt(entity.contentSize || 0),
            meta: {
              storagePath: entity['@id'],
            },
          },
        }),
      };
      await pq.enqueue(param);
    }
    await pq.done();
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
    const where = crateId ? { id: { startsWith: crateId } } : {};
    //const truncate = !crateId;
    await prisma.file.deleteMany({ where });
    await prisma.entity.deleteMany({ where });
    logger.debug(`[structural] Index ${crateId || '<all>'} deleted`);
    //await File.destroy({ truncate, where });
  }

  async count(crateId?: string) {
    let opt;
    if (crateId) {
      opt = {
        where: { id: crateId },
      };
    }
    return await prisma.entity.count(opt);
  }
}

function entityAsCrate(crate: ROCrate, entity: any) {
  const newCrate = new ROCrate({ array: true, link: true });
  for (const key in entity) {
    newCrate.root[key] = entity[key];
  }
  newCrate.root['@type'].push('Dataset');
  if (!entity.conformsTo) {
    newCrate.root.conformsTo = crate.root.conformsTo;
  }
  return newCrate.toJSON();
}
