//import config from '../prisma.config.ts';
import { Readable } from 'node:stream';
import cors from '@fastify/cors';
import fastifyRoutes from '@fastify/routes';
import fastifySensible from '@fastify/sensible';
import { Client } from '@opensearch-project/opensearch';
import type { Options } from 'arocapi';
import arocapi from 'arocapi';
import type { RegisterOptions } from 'fastify';
import ldacapi, { fileHandler } from './app.ts';
import { accessTransformer, resolveValidLicenses } from './auth.ts';
import { config } from './configuration.ts';
import { prisma } from './prisma.ts';
import { auth } from './routes/auth.ts';
import { fastify } from './utils.ts';

const opensearch = new Client({ node: config.opensearchUrl });

const appOpt: Options & RegisterOptions = {
  prisma,
  opensearch,
  disableCors: true,
  queryBuilderOptions: { aggregations: config.search.aggregations },
  accessTransformer: accessTransformer,
  fileAccessTransformer: accessTransformer,
  resolveValidLicenses,
  entityTransformers: [
    (entity) => {
      entity.accessControl = 'Public';
      entity.counts = {
        collections: 0,
        objects: 0,
        files: 0,
      };
      return entity;
    },
  ],
  fileHandler,
  // Required: RO-Crate handler for serving RO-Crate metadata
  roCrateHandler: {
    get: async (entity) => {
      const jsonString = JSON.stringify(entity.meta.rocrate, null, 2);
      return {
        type: 'stream' as 'stream',
        stream: Readable.from([jsonString]),
        metadata: {
          contentType: 'application/ld+json',
          contentLength: Buffer.byteLength(jsonString),
        },
      };
    },
    head: async (entity) => ({
      contentType: 'application/ld+json',
      contentLength: Buffer.byteLength(JSON.stringify(entity.meta.rocrate)),
    }),
  },
  prefix: config.prefix || '',
  aggregations: config.search.aggregations,
};
fastify.decorateRequest('userLicenses', null);
fastify.decorateRequest('userId', null);
fastify.register(fastifySensible);
fastify.register(cors, {
  methods: ['HEAD', 'GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});
fastify.register(fastifyRoutes, { prefix: appOpt.prefix });
fastify.register(arocapi, appOpt);
fastify.register(ldacapi, appOpt);
fastify.register(auth, { prefix: config.prefixAuth || config.prefix || '' });
// Run the server!
(async () => {
  try {
    await fastify.listen({ port: config.port, host: config.host });
    if (config.isDev) {
      fastify.log.info(`Server is running on development mode`);
    }
    fastify.log.debug(`Using database ${config.databaseUrl}`);
    fastify.log.debug(`Using opensearch ${config.opensearchUrl}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
})();
