import type { Client } from '@opensearch-project/opensearch';
import type { PrismaClient } from '@prisma/client/extension';
import type { AccessTransformer, EntityTransformer, FileHandler, FileMetadata } from 'arocapi';
import type { FastifyPluginAsync } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import pkg from '../package.json' with { type: 'json' };
import type { File } from './generated/prisma/client.ts';
import { initRepository, type Repository } from './repository.ts';
import { admin as adminRoute } from './routes/admin.ts';
import { fileRoute } from './routes/file.ts';
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
  fastify.register(adminRoute, { prefix: '/admin', repository });
  fastify.register(fileRoute, { prefix: '/dav', repository, prisma: options.prisma, signatures });

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
    //console.log('fileHandler', file);
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
