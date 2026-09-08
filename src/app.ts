import type { Client } from '@opensearch-project/opensearch';
import type { PrismaClient } from '@prisma/client/extension';
import type { AccessTransformer, EntityTransformer, FileHandler, FileMetadata } from 'arocapi';
import type { FastifyPluginAsync } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import pkg from '../package.json' with { type: 'json' };
import type { File } from './generated/prisma/client.ts';
import { initRepository, type Repository } from './repository.ts';
import { admin } from './routes/admin.ts';
import { log } from './utils.ts';

// declare module 'fastify' {
//   interface FastifyInstance {
//     repository: Repository;
//   }
// }

export type LdacapiOptions = {
  prisma: PrismaClient;
  opensearch: Client;
  disableCors?: boolean;
  accessTransformer: AccessTransformer;
  entityTransformers?: EntityTransformer[];
  aggregations?: Record<string, unknown>;
};

let repository: Repository;
const signatures = new Map<string, string>();

const ldacapi: FastifyPluginAsync<LdacapiOptions> = async (fastify, options: LdacapiOptions) => {
  const aggregations = Object.keys(options.aggregations || {});
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);
  repository = await initRepository('ocfl', { opensearchClient: options.opensearch });
  fastify.decorate('repository', repository);

  // Declare a route
  fastify.get('/', async function handler(_request, _replyy) {
    const routes = fastify.routes.keys().toArray();
    return {
      about: 'Example implementation of mounting an ROCrate API in a fastify app',
      routes,
    };
  });

  const { version } = pkg;
  fastify.register(admin, { prefix: '/admin', repository });

  fastify.get('/version', async () => ({ version }));
  fastify.get('/capabilities', async () => ({
    apiVersion: '0.0.0',
    deposit: {
      supported: false,
    },
    tombstonePolicy: '404',
    extensions: {},
    search: {
      filters:
        Object.fromEntries(aggregations.map((name) => [name, { type: 'string' }])),
      facets:
        Object.fromEntries(aggregations.map((name) => [name, {}])),
    },
  }));
  fastify.get('/dav/:crateId/*', async (request, reply) => {
    const crateId = request.params.crateId;
    const filePath = request.params['*'];
    if (!crateId || !filePath) {
      return reply.badRequest('Missing crateId or filePath');
    }
    const entityId = crateId + '/' + filePath;
    const signature = request.query.signature;
    if (!signature || signatures.get(signature) !== entityId) {
      return reply.unauthorized('Invalid or missing signature');
    }
    try {
      const file = await options.prisma.file.findUnique({
        where: { id: entityId },
        include: { entity: true },
      });

      if (!file) {
        return reply.notFound(`File metadata not found: ${entityId}`);
      }

      const rf = await repository.getFile(crateId, filePath);
      if (!rf) return reply.notFound(`File not found: ${crateId}/${filePath}`);

      const disposition = request.query.disposition || 'attachment';
      const filename = request.query.filename || file.filename || filePath.split('/').pop() || 'file';
      // filename can contain unicode chars which aren't valid raw header bytes; use RFC 5987 encoding
      reply.header('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);
      reply.header('Content-Type', file.mediaType);
      if (request.headers.via?.includes('nginx')) {
        // try to auto-detect nginx proxy using `via` header
        // if detected, use the x-accel feature to let nginx serve the requested file directly
        const path = encodeURI('/ocfl/' + rf.path);
        reply.header('X-Accel-Redirect', path);
        return reply.code(200).send();
      } else {
        reply.header('Content-Length', file.size.toString());

        // if (metadata.etag) {
        //   reply.header('ETag', metadata.etag);
        // }
        // if (metadata.lastModified) {
        //   reply.header('Last-Modified', metadata.lastModified.toUTCString());
        // }
        return reply.code(200).send(await rf.stream());
      }

    } catch (error) {
      const err = error as Error;
      fastify.log.error(`File retrieval error: ${err.message}`);
      return reply.internalServerError('Error retrieving file');
    }

  });
};

export default ldacapi;

function fileMetadata(file: File): FileMetadata {
  return {
    contentType: file.mediaType,
    contentLength: file.size as unknown as number,
  };
}

export const fileHandler: FileHandler = {
  get: async (file, { request }) => {
    const { disposition, filename } = request.query;
    const storagePath = file.meta.storagePath;
    log.debug(`fileHandler: ${file.id}  ${file.meta.storagePath}`);
    const crateId = (storagePath && file.id.endsWith('/' + storagePath)) ? file.id.slice(0, -storagePath.length - 1) : file.id;
    const signature = generateSignature(file.id);
    return {
      type: 'redirect',
      url: `/api/dav/${encodeURIComponent(crateId)}/${encodeURI(storagePath)}?disposition=${disposition}&filename=${encodeURIComponent(filename)}&signature=${signature}`
    };
  },
  head: async (file) => fileMetadata(file),
};


function generateSignature(url: string) {
  const token = crypto.randomUUID();
  signatures.set(token, url);
  setTimeout(() => signatures.delete(token), 60 * 1000); // expire after 1 minutes
  return token;
}
