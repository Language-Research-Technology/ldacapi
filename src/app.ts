import cors from '@fastify/cors';
import fastifySensible from '@fastify/sensible';
import type { SearchBackend } from 'arocapi';
import arocapi, { AllVisibleEntityFilter, AllVisibleSearchFilter, errorHandler, notFoundHandler } from 'arocapi';
import { EntityMetaMetadata } from 'arocapi/storage/entity-meta';
import Fastify, { type FastifyPluginAsync } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import pkg from '../package.json' with { type: 'json' };
import { access, isAuthenticated } from './auth.ts';
import { config } from './configuration.ts';
import { logger } from './logger.ts';
import { oidcProvider } from './oidc/provider.ts';
import { prisma } from './prisma.ts';
import type { Repository } from './repository.ts';
import { admin } from './routes/admin.ts';
import { auth } from './routes/auth.ts';

type AppDeps = {
  repository: Repository;
  search: SearchBackend;
};

const ldacapi: FastifyPluginAsync<{ repository: Repository }> = async (fastify, { repository }) => {
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);
  fastify.register(admin, { prefix: '/admin', repository });
  fastify.get('/version', async () => ({ version: pkg.version }));
};

export function buildApp({ repository, search }: AppDeps) {
  const fastify = Fastify({
    loggerInstance: logger,
    routerOptions: {
      maxParamLength: config.maxParamLength,
    },
    trustProxy: true, // this is required for auth module to work corractly when the app is behind a reverse proxy. The proxy must set the X-Forwarded-* headers correctly.
  });
  const prefix = config.prefix || '';

  fastify.setErrorHandler(errorHandler);
  fastify.setNotFoundHandler(notFoundHandler);
  fastify.register(fastifySensible);
  fastify.register(cors, {
    methods: ['HEAD', 'GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  fastify.register(arocapi, {
    prisma,
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
  });
  fastify.register(ldacapi, { prefix, repository });
  if (config.auth.enabled) {
    fastify.register(oidcProvider);
  }
  fastify.register(auth, { prefix: config.prefixAuth || prefix });

  return fastify;
}
