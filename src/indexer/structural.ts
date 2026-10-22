import type { OcflStorageMeta } from 'arocapi';
import { type Entity, ROCrate } from 'ro-crate';
import type { Prisma } from '../generated/prisma/client.ts';
import { logger } from '../logger.ts';
import { prisma } from '../prisma.ts';
import { firstStringOrId } from '../utils.ts';
import { type BaseOptions, type CrateFile, Indexer, RecordType, recordType } from './indexer.ts';

const log = logger.child({ module: 'indexer/structural' });

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

  override async _index({ crateObject, crate, paths, license, metadataLicense }: Parameters<Indexer['_index']>[0]) {
    const crateId = crate.rootId;
    let count = 0;
    for (const entity of crate.entities()) {
      const entityType = recordType(entity);
      if (!entityType) {
        continue;
      }
      log.debug({ crateId, entityId: entity['@id'] }, 'Indexing entity');
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
        const ocflPath = paths.get(entityId);
        let f: CrateFile = { size: -1, crc32: '' };
        if (ocflPath) {
          try {
            f = await crateObject.file(ocflPath);
          } catch (error) {
            log.error({ err: error, crateId, entityId, ocflPath }, 'Cannot read file');
          }
        }
        param.file = {
          id: entityId,
          filename: (ocflPath ?? entityId).split('/').pop(),
          mediaType: entity.encodingFormat?.find((v: unknown) => typeof v === 'string') || 'application/octet-stream',
          size: +(entity.contentSize?.[0] ?? f.size),
          meta: ocflPath ? ({ ocflObject: crateObject.id, ocflPath, crc32: f.crc32 } satisfies OcflStorageMeta & { crc32: string }) : {},
        };
      }
      try {
        await prisma.entity.create({ data: param.entity });
        if (param.file) {
          await prisma.file.create({ data: param.file });
        }
      } catch (error) {
        log.error({ err: error, crateId, entityId }, 'Error indexing entity');
      }
    }

    log.info({ crateId, entities: count }, 'Indexed crate');
  }

  async delete(crateId?: string) {
    await prisma.file.deleteMany({ where: crateId ? { entity: { rootCollection: crateId } } : {} });
    await prisma.entity.deleteMany({ where: crateId ? { rootCollection: crateId } : {} });
    log.debug({ crateId }, 'Index deleted');
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

export function pickSingleMemberOf(entity: Entity) {
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
