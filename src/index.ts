import cors from '@fastify/cors';
import fastifySensible from '@fastify/sensible';
import { Client } from '@opensearch-project/opensearch';
import type { Options } from 'arocapi';
import arocapi, { AllVisibleEntityFilter, AllVisibleSearchFilter, errorHandler, notFoundHandler } from 'arocapi';
import { EntityMetaMetadata } from 'arocapi/storage/entity-meta';
import type { RegisterOptions } from 'fastify';
import ldacapi, { type LdacapiOptions } from './app.ts';
import { access, isAuthenticated } from './auth.ts';
import { config } from './configuration.ts';
import { createSearchBackend } from './indexer/search.ts';
import { prisma } from './prisma.ts';
import { initRepository } from './repository.ts';
import { auth } from './routes/auth.ts';
import { fastify } from './utils.ts';

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
