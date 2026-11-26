import type { AuthorisedFile, FileTransformer } from 'arocapi';
import type { FastifyRequest } from 'fastify';
import type { PrismaClient } from './generated/prisma/client.ts';

type EntityReference = { id: string; name: string } | null;

const parentsByRequest = new WeakMap<FastifyRequest, Map<string, Promise<EntityReference>>>();

/** The entity each file is a member of, as arocapi gives entities; the Downloader groups an export by it */
export const memberOfFileTransformer =
  (db: Pick<PrismaClient, 'entity'>): FileTransformer<AuthorisedFile, AuthorisedFile & { memberOf: EntityReference }> =>
  async (file, { request }, { entity }) => {
    if (!entity.memberOf) {
      return { ...file, memberOf: null };
    }
    const parents = parentsByRequest.get(request) ?? new Map<string, Promise<EntityReference>>();
    parentsByRequest.set(request, parents);
    let parent = parents.get(entity.memberOf);
    if (!parent) {
      parent = db.entity.findUnique({ where: { id: entity.memberOf }, select: { id: true, name: true } });
      parents.set(entity.memberOf, parent);
    }
    return { ...file, memberOf: await parent };
  };
