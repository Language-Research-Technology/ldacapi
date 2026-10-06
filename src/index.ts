//import config from '../prisma.config.ts';
import { Readable } from 'node:stream';
import cors from '@fastify/cors';
import fastifyRoutes from '@fastify/routes';
import fastifySensible from '@fastify/sensible';
import { Client } from '@opensearch-project/opensearch';
import type { AggregationContainer } from '@opensearch-project/opensearch/api/_types/_common.aggregations.js';
import type { Options } from 'arocapi';
import arocapi from 'arocapi';
import type { RegisterOptions } from 'fastify';
import ldacapi, { fileHandler, type LdacapiOptions } from './app.ts';
import { accessTransformer, fileAccessTransformer } from './auth.ts';
import { config } from './configuration.ts';
import { prisma } from './prisma.ts';
import { auth } from './routes/auth.ts';
import { fastify } from './utils.ts';

const opensearch = new Client({ node: config.opensearchUrl });
const prefix = config.prefix || '';

const appOpt: Options & LdacapiOptions & RegisterOptions = {
  prisma,
  opensearch,
  disableCors: true,
  // OpenSearch's TermsAggregationFields type omits `field`
  queryBuilderOptions: { aggregations: config.search.aggregations as unknown as Record<string, AggregationContainer> },
  accessTransformer: accessTransformer,
  fileAccessTransformer,
  // arocapi doesn't support this option yet
  // resolveValidLicenses,
  entityTransformers: [
    (entity) => ({
      ...entity,
      accessControl: 'Public',
      counts: {
        collections: 0,
        objects: 0,
        files: 0,
      },
    }),
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
  prefix,
  aggregations: config.search.aggregations,
};
fastify.decorateRequest('userLicenses', null);
fastify.decorateRequest('userId', null);
fastify.register(fastifySensible);
fastify.register(cors, {
  methods: ['HEAD', 'GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});
fastify.register(fastifyRoutes, { prefix });
fastify.register(arocapi, appOpt);
fastify.register(ldacapi, appOpt);
fastify.register(auth, { prefix: config.prefixAuth || prefix });
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
