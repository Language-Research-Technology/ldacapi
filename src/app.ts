import type { Client } from '@opensearch-project/opensearch';
import type { PrismaClient } from '@prisma/client/extension';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { AccessTransformer, EntityTransformer } from 'arocapi';
import pkg from "../package.json" with { type: "json" };

import fp from 'fastify-plugin';
import { admin } from './routes/admin.ts';
import { initRepository } from './repository.ts';

export type Options = {
  prisma: PrismaClient;
  opensearch: Client;
  disableCors?: boolean;
  accessTransformer: AccessTransformer;
  entityTransformers?: EntityTransformer[];
};

const app: FastifyPluginAsync<Options> = async (fastify, options) => {
  const repository = await initRepository('ocfl');

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

};

export default fp(app);
