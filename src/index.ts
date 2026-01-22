//import config from '../prisma.config.ts';
import { PrismaClient } from './generated/prisma/client.ts';
import { Client } from '@opensearch-project/opensearch';
import Fastify from 'fastify';
import fastifyRoutes from '@fastify/routes';
import fastifySensible from '@fastify/sensible';
import arocapi, { AllPublicAccessTransformer, AllPublicFileAccessTransformer } from 'arocapi';
import ldacapi from './app.ts';
import { Readable } from 'node:stream';
import { init } from './indexer/ocfl.ts';

const opensearchUrl = process.env.OPENSEARCH_URL || 'http://localhost:9200';
const port = parseInt(process.env.LDACAPI_PORT || '8080');
export const prisma = new PrismaClient();
const opensearch = new Client({ node: opensearchUrl });

const fastify = Fastify({
  logger: {level: 'debug', transport: { target: 'pino-pretty' }},
})
const appOpt = {
  prisma,
  opensearch,
  accessTransformer: AllPublicAccessTransformer,
  fileAccessTransformer: AllPublicFileAccessTransformer,
  fileHandler: {
    get: async (file) => {
      const fileUrl = `https://storage.example.com/${file.meta.storagePath}`;
      return { type: 'redirect' as 'redirect', url: fileUrl };
    },
    head: async (file) => ({
      contentType: file.mediaType,
      contentLength: file.size,
    }),
  },
  // Required: RO-Crate handler for serving RO-Crate metadata
  roCrateHandler: {
    get: async (entity) => {
      const jsonString = JSON.stringify(entity.rocrate, null, 2);
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
      contentLength: Buffer.byteLength(JSON.stringify(entity.rocrate)),
    }),
  }
};

//fastify.register(fastifySensible);
fastify.register(fastifyRoutes);
fastify.register(arocapi, appOpt);
fastify.register(ldacapi, appOpt);

await fastify.ready();

// Run the server!
try {
  await fastify.listen({ port })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}

export const logger = fastify.log;

init();