import { type Entity, ROCrate } from 'ro-crate';
import type { Prisma } from '../generated/prisma/client.ts';
import { prisma } from '../prisma.ts';
import { firstStringOrId, log as plog } from '../utils.ts';
import { type BaseOptions, type CrateFile, Indexer, RecordType, recordType } from './indexer.ts';

const log = plog.child({ module: 'indexer/structural' });

type IndexRecord = { entity: Prisma.EntityUncheckedCreateInput; file?: Prisma.FileUncheckedCreateInput };

type StructuralOptions = BaseOptions & {
  memberOfField?: string;
};

export class StructuralIndexer extends Indexer {
  memberOfField: string;

  constructor(opt: StructuralOptions) {
    super(opt);
    this.memberOfField = opt.memberOfField || 'pcdm:memberOf';
  }

  override async _index({ crateObject, crate, license, metadataLicense }: Parameters<Indexer['_index']>[0]) {
    //await ocflObject.load();
    const crateId = crate.rootId;
    //console.log(`${crateId} license: ${lic}`);
    //const objectRoot = ocflObject.root;
    //logger.info(`[structural] Indexing ${crateId}`);
    let count = 0;
    for (const entity of crate.entities()) {
      const entityType = recordType(entity);
      if (!entityType) {
        continue;
      }
      log.debug(`Indexing ${crateId} ${entity['@id']}`);
      count++;
      const entityId = entity['@id'];
      const rocrate = entityAsCrate(crate, entity, license);
      const param: IndexRecord = {
        entity: {
          id: entityId,
          name: entity.name?.join('; ') || entityId,
          description: entity.description?.join('; ') || '',
          entityType: crate.getContextDefinition(entityType) || RecordType[entityType],
          memberOf: pickSingleMemberOf(entity),
          rootCollection: crate.rootId,
          metadataLicenseId: metadataLicense,
          contentLicenseId: firstStringOrId(entity.license) || license,
          meta: { rocrate },
        },
      };
      if (entityType.endsWith('://schema.org/MediaObject') || entityType === 'File') {
        const storagePath = entity['@id'].match(/.+:.+/) ? entity['@id'].replace(`${crateId}/`, '') : entity['@id'];
        let f: CrateFile = { size: -1, crc32: '' };
        try {
          f = await crateObject.file(storagePath);
        } catch (error) {
          log.error(`[${crateId}] ${(error as Error).message}`);
        }
        param.file = {
          id: entityId,
          filename: storagePath.split('/').pop(),
          mediaType: entity.encodingFormat?.find((v: unknown) => typeof v === 'string') || 'application/octet-stream',
          size: +(entity.contentSize?.[0] ?? f.size),
          meta: {
            storagePath,
            crc32: f.crc32,
          },
        };
      }
      try {
        await prisma.entity.create({ data: param.entity });
        if (param.file) {
          await prisma.file.create({ data: param.file });
        }
      } catch (error) {
        log.error(`Error indexing ${crateId} ${entityId}: ${(error as Error).message}`);
      }
    }

    log.info(`Indexed ${crateId}: entities=${count}`);
  }

  async delete(crateId?: string) {
    const where = crateId ? { id: { startsWith: crateId } } : {};
    //const truncate = !crateId;
    await prisma.file.deleteMany({ where });
    await prisma.entity.deleteMany({ where });
    log.debug(`Index ${crateId || '<all>'} deleted`);
    //await File.destroy({ truncate, where });
  }

  async count(crateId?: string) {
    return await prisma.entity.count(crateId ? { where: { id: crateId } } : undefined);
  }
}

export function entityAsCrate(crate: ROCrate, entity: Entity, license: string) {
  const newCrate = new ROCrate({ '@context': crate['@context'] }, { array: true, link: true });
  for (const key in entity) {
    newCrate.root[key] = entity[key];
  }
  newCrate.root['@type'].push('Dataset');
  if (!entity.conformsTo) {
    newCrate.root.conformsTo = crate.root.conformsTo;
  }
  if (!entity.license) {
    newCrate.root.license = license;
  }
  return newCrate.toJSON();
}

function pickSingleMemberOf(entity: Entity) {
  return (
    entity['pcdm:memberOf']?.[0]['@id'] ||
    entity.memberOf?.[0]['@id'] ||
    entity['@reverse']['pcdm:hasMember']?.[0]?.['@id'] ||
    entity['@reverse'].hasMember?.[0]?.['@id'] ||
    entity.isPartOf?.find((e: Entity) => e['@type'].includes('RepositoryObject'))?.['@id'] ||
    entity['@reverse'].hasPart?.find((e: Entity) => e['@type'].includes('RepositoryObject'))?.['@id'] ||
    entity.isPartOf?.[0]['@id'] ||
    entity['@reverse'].hasPart?.[0]?.['@id'] ||
    null
  );
}
