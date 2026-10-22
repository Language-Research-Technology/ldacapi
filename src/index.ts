import cors from '@fastify/cors';
import fastifySensible from '@fastify/sensible';
import { Client } from '@opensearch-project/opensearch';
import type { Options } from 'arocapi';
import arocapi, { AllVisibleEntityFilter, AllVisibleSearchFilter, errorHandler, notFoundHandler } from 'arocapi';
import { EntityMetaMetadata } from 'arocapi/storage/entity-meta';
import Fastify, { type RegisterOptions } from 'fastify';
import ldacapi, { type LdacapiOptions } from './app.ts';
import { access, isAuthenticated } from './auth.ts';
import { config } from './configuration.ts';
import { createSearchBackend } from './indexer/search.ts';
import { logger } from './logger.ts';
import { prisma } from './prisma.ts';
import { initRepository } from './repository.ts';
import { auth } from './routes/auth.ts';

const fastify = Fastify({
  loggerInstance: logger,
  routerOptions: {
    maxParamLength: config.maxParamLength,
  },
  trustProxy: true, // this is required for auth module to work corractly when the app is behind a reverse proxy. The proxy must set the X-Forwarded-* headers correctly.
});

const opensearch = new Client({ node: config.opensearchUrl });
const prefix = config.prefix || '';
const search = createSearchBackend(opensearch);
const repository = await initRepository('ocfl', { opensearchClient: opensearch, search });

const appOpt: Options & LdacapiOptions & RegisterOptions = {
  prisma,
  repository,
  search,
  access,
  isAuthenticated,
  entityVisibilityFilter: AllVisibleEntityFilter,
  searchVisibilityFilter: AllVisibleSearchFilter,
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
  storage: { metadata: EntityMetaMetadata(), content: repository.storage().content },
  prefix,
};
fastify.setErrorHandler(errorHandler);
fastify.setNotFoundHandler(notFoundHandler);
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
  } catch (err) {
    fastify.log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
})();
