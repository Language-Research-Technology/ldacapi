import type { OcflStorageMeta } from 'arocapi';
import { type Entity, ROCrate } from 'ro-crate';
import { accessControlFor } from '../access/access-control.ts';
import type { EntityMeta } from '../entity-meta.ts';
import type { Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { logger } from '../logger.ts';
import { firstStringOrId } from '../utils.ts';
import { type CrateFile, entityClass, type Licences, memberOf, recordType, rootCollection, type WriteParams, Writer } from './writer.ts';

const log = logger.child({ module: 'indexer/rows' });

type IndexRecord = { entity: Prisma.EntityUncheckedCreateInput; file?: Prisma.FileUncheckedCreateInput };

/** Writes a crate's Entity and File rows */
export class RowsWriter extends Writer {
  prisma: PrismaClient;

  constructor(prisma: PrismaClient, licences: Licences) {
    super(licences);
    this.prisma = prisma;
  }

  override async write({ crateObject, crate, paths, license, metadataLicense, topCollection }: WriteParams) {
    const crateId = crate.rootId;
    for (const entity of crate.entities()) {
      const entityType = recordType(entity);
      if (!entityType) {
        continue;
      }
      log.debug({ crateId, entityId: entity['@id'] }, 'Indexing entity');
      const entityId = entity['@id'];
      const rocrate = entityAsCrate(crate, entity, license);
      const contentLicenseId = firstStringOrId(entity.license) || license;
      const param: IndexRecord = {
        entity: {
          id: entityId,
          name: entity.name?.join('; ') || entityId,
          description: entity.description?.join('; ') || '',
          entityType: entityClass(crate, entityType),
          memberOf: pickSingleMemberOf(entity),
          rootCollection: rootCollection(topCollection, entityId),
          metadataLicenseId: metadataLicense,
          contentLicenseId,
          meta: { crateId, rocrate, accessControl: accessControlFor(contentLicenseId) } satisfies EntityMeta,
        },
      };
      if (entityType.endsWith('://schema.org/MediaObject') || entityType === 'File') {
        const ocflPath = paths.get(entityId);
        let f: CrateFile | undefined;
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
          size: f?.size ?? statedSize(entity.contentSize?.[0]),
          meta: ocflPath ? ({ ocflObject: crateObject.id, ocflPath } satisfies OcflStorageMeta) : {},
        };
      }
      try {
        await this.prisma.entity.create({ data: param.entity });
        if (param.file) {
          await this.prisma.file.create({ data: param.file });
        }
      } catch (error) {
        log.error({ err: error, crateId, entityId }, 'Error indexing entity');
      }
    }
  }

  async delete(crateId: string) {
    await this.prisma.file.deleteMany({ where: { entity: rowsOf(crateId) } });
    await this.prisma.entity.deleteMany({ where: rowsOf(crateId) });
  }
}

/** The entity rows indexed from `crateId` */
const rowsOf = (crateId: string): Prisma.EntityWhereInput => ({ meta: { path: ['crateId'], equals: crateId } });

/** The id and rootCollection of each entity row indexed from `crateId` */
export const crateRows = (prisma: PrismaClient, crateId: string) =>
  prisma.entity.findMany({ where: rowsOf(crateId), select: { id: true, rootCollection: true } });

/** How many entity and file rows were indexed from `crateId` */
export const countRows = async (prisma: PrismaClient, crateId: string) => ({
  entities: await prisma.entity.count({ where: rowsOf(crateId) }),
  files: await prisma.file.count({ where: { entity: rowsOf(crateId) } }),
});

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

/** The leading integer of a schema.org contentSize, which is text such as "14384 bytes", or -1 */
function statedSize(contentSize: unknown) {
  const size = Number.parseInt(String(contentSize), 10);
  return Number.isNaN(size) ? -1 : size;
}

export function pickSingleMemberOf(entity: Entity) {
  return (
    memberOf(entity) ||
    entity['@reverse']['pcdm:hasMember']?.[0]?.['@id'] ||
    entity['@reverse'].hasMember?.[0]?.['@id'] ||
    entity.isPartOf?.find((e: Entity) => e['@type'].includes('RepositoryObject'))?.['@id'] ||
    entity['@reverse'].hasPart?.find((e: Entity) => e['@type'].includes('RepositoryObject'))?.['@id'] ||
    entity.isPartOf?.[0]['@id'] ||
    entity['@reverse'].hasPart?.[0]?.['@id'] ||
    null
  );
}
