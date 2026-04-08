//import config from '../prisma.config.ts';
import cors from '@fastify/cors';
import fastifyRoutes from '@fastify/routes';
import { Client } from '@opensearch-project/opensearch';
import { PrismaPg } from "@prisma/adapter-pg";
import type { Options } from 'arocapi';
import arocapi, { AllPublicAccessTransformer, AllPublicFileAccessTransformer } from 'arocapi';
import Fastify from 'fastify';
import { Readable } from 'node:stream';
import ldacapi, { fileHandler } from './app.ts';
import { config } from './configuration.ts';
import { PrismaClient } from './generated/prisma/client.ts';

const opensearchUrl = process.env.OPENSEARCH_URL || 'http://localhost:9200';
const port = parseInt(process.env.LDACAPI_PORT || '8080');
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL })
});
const opensearch = new Client({ node: opensearchUrl });

const fastify = Fastify({
  //logger: { level: 'debug' },
  logger: { level: 'debug', transport: { target: 'pino-pretty' } },
  // routerOptions: {
  //   ignoreTrailingSlash: true,
  // }
})
export const logger = fastify.log;

const appOpt: Options = {
  prisma,
  opensearch,
  disableCors: true,
  queryBuilderOptions: { aggregations: config.search.aggregations },
  accessTransformer: AllPublicAccessTransformer,
  fileAccessTransformer: AllPublicFileAccessTransformer,
  entityTransformers: [
    (entity, { fastify }) => {
      entity.accessControl = 'Public';
      entity.counts = {
        collections: 0,
        objects: 0,
        files: 0
      }
      return entity;
    }
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
  }
};

//fastify.register(fastifySensible);
fastify.register(cors, {
  methods: ['HEAD', 'GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});
fastify.register(fastifyRoutes);
fastify.register(arocapi, appOpt);
fastify.register(ldacapi, appOpt);

// Run the server!
(async function () {
  try {
    await fastify.ready();
    await fastify.listen({ port })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})();

