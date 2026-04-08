import type { Client } from '@opensearch-project/opensearch';
import type { PrismaClient } from '@prisma/client/extension';
import type { AccessTransformer, EntityTransformer, FileHandler, FileMetadata } from 'arocapi';
import pkg from "../package.json" with { type: "json" };

import fp from 'fastify-plugin';
import type { File } from './generated/prisma/client.ts';
import { logger } from './index.ts';
import { initRepository, type Repository } from './repository.ts';
import { admin } from './routes/admin.ts';

declare module 'fastify' {
  interface FastifyInstance {
    repository: Repository;
  }
}

export type Options = {
  prisma: PrismaClient;
  opensearch: Client;
  disableCors?: boolean;
  accessTransformer: AccessTransformer;
  entityTransformers?: EntityTransformer[];
};

export default fp(async (fastify, options: Options) => {
  const repository = await initRepository('ocfl', { opensearchClient: options.opensearch });
  fastify.decorate('repository', repository);

  // Declare a route
  fastify.get('/', async function handler(request, reply) {
    const routes = fastify.routes.keys().toArray();
    return {
      about: 'Example implementation of mounting an ROCrate API in a fastify app',
      routes,
    };
  });

  const { version } = pkg;
  fastify.get('/version', async () => ({ version }));
  fastify.register(admin, { prefix: '/admin', repository });

});

function fileMetadata(file: File): FileMetadata {
  return {
    contentType: file.mediaType,
    contentLength: file.size as unknown as number,
  };
}

export const fileHandler: FileHandler = {
  get: async (file, { fastify, request }) => {
    logger.debug(`Get object file`);
    logger.debug(file);
    const metadata = fileMetadata(file);
    const rf = await fastify.repository.getFile(file.id, file.meta.storagePath);
    //if (!rf) return fastify.httpErrors.notFound(`File not found: ${file.id}`);
    if (!rf) return false;
    if (request.headers.via?.includes('nginx')) {
      // try to auto-detect nginx proxy using `via` header
      // if detected, use the x-accel feature to let nginx serve the requested file directly
      const path = encodeURI('/ocfl/' + rf.path);
      return { type: 'file' as 'file', metadata, path, accelPath: path };
    } else {
      return { type: 'stream' as 'stream', metadata, stream: await rf.stream() };
    }
  },
  head: async (file) => fileMetadata(file),
}
