//import config from '../prisma.config.ts';
import { Readable } from 'node:stream';
import cors from '@fastify/cors';
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

const serialiseRoCrate = (entity: { meta: { rocrate: unknown } }) => JSON.stringify(entity.meta.rocrate, null, 2);

const opensearch = new Client({ node: config.opensearchUrl });
const prefix = config.prefix || '';

const appOpt: Options & LdacapiOptions & RegisterOptions = {
  prisma,
  opensearch,
  // OpenSearch's TermsAggregationFields type omits `field`
  queryBuilderOptions: { aggregations: config.search.aggregations as unknown as Record<string, AggregationContainer> },
  accessTransformer: accessTransformer,
  fileAccessTransformer,
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
      const jsonString = serialiseRoCrate(entity);
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
      contentLength: Buffer.byteLength(serialiseRoCrate(entity)),
    }),
  },
  prefix,
};
fastify.decorateRequest('userLicenses', null);
fastify.decorateRequest('userId', null);
fastify.register(fastifySensible);
fastify.register(cors, {
  methods: ['HEAD', 'GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});
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
