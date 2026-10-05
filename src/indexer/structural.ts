import { ROCrate } from 'ro-crate';
import { prisma } from '../index.ts';
import { firstStringOrId, PromiseQueue, log as plog } from '../utils.ts';
import { type CrateFile, Indexer, RecordType } from './indexer.ts';

const log = plog.child({ module: 'indexer/structural' });

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

  override async _index({ crateObject, crate, license, metadataLicense }: Parameters<Indexer['_index']>[0]) {
    //await ocflObject.load();
    const crateId = crate.rootId;
    //console.log(`${crateId} license: ${lic}`);
    //const objectRoot = ocflObject.root;
    //logger.info(`[structural] Indexing ${crateId}`);
    let count = 0;
    const pq = new PromiseQueue(4, async (opt: any) => {
      for (const tableName in opt) {
        const data = opt[tableName];
        //console.log(data.Metadatalicense);
        if (data) {
          try {
            // @ts-expect-error
            await prisma[tableName].create({ data });
          } catch (error) {
            log.error(`Error indexing ${crateId} ${data.id}: ${(error as Error).message}`);
          }
        }
      }
    });

    // rename all @id first
    const descriptorId = crate.descriptor['@id'];
    for (const entity of crate.entities()) {
      if (entity['@id'] === descriptorId) {
        continue;
      }
      const entityId = this.deriveUniqueEntityId(crateId, entity['@id']);
      if (entityId !== entity['@id']) {
        entity['@id'] = entityId;
      }
    }
    for (const entity of crate.entities()) {
      const entityType = entity['@type'].find((t) => t in RecordType); // only the first matching entity type is used
      if (!entityType) {
        continue;
      }
      const mustHaveConformsTo = RecordType[entityType as keyof typeof RecordType];
      if (mustHaveConformsTo) {
        const conformsTo = entity.conformsTo?.find((c) => c['@id'] === mustHaveConformsTo);
        if (!conformsTo) {
          continue;
        }
      }
      log.debug(`Indexing ${crateId} ${entity['@id']}`);
      count++;
      const entityId = entity['@id'];
      const rocrate = entityAsCrate(crate, entity, license);
      const param = {
        entity: {
          id: entityId,
          name: entity.name?.join('; ') || entityId,
          description: entity.description?.join('; ') || '',
          entityType: crate.getContextDefinition(entityType) || RecordType[entityType as keyof typeof RecordType],
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
        /* @ts-expect-error */
        param.file = {
          id: entityId,
          filename: storagePath.split('/').pop(),
          mediaType: entity.encodingFormat?.find((v) => typeof v === 'string') || 'application/octet-stream',
          size: +(entity.contentSize?.[0] ?? f.size),
          meta: {
            storagePath,
            crc32: f.crc32,
          },
        };
      }
      await pq.enqueue(param);
    }
    await pq.done();

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
    let opt;
    if (crateId) {
      opt = {
        where: { id: crateId },
      };
    }
    return await prisma.entity.count(opt);
  }
}

export function entityAsCrate(crate: ROCrate, entity: any, license: string) {
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

function pickSingleMemberOf(entity: any) {
  return (
    entity['pcdm:memberOf']?.[0]['@id'] ||
    entity.memberOf?.[0]['@id'] ||
    entity['@reverse']['pcdm:hasMember']?.[0]?.['@id'] ||
    entity['@reverse'].hasMember?.[0]?.['@id'] ||
    entity.isPartOf?.find((e) => e['@type'].includes('RepositoryObject'))?.['@id'] ||
    entity['@reverse'].hasPart?.find((e) => e['@type'].includes('RepositoryObject'))?.['@id'] ||
    entity.isPartOf?.[0]['@id'] ||
    entity['@reverse'].hasPart?.[0]?.['@id'] ||
    null
  );
}
