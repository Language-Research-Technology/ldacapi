import cors from '@fastify/cors';
import fastifySensible from '@fastify/sensible';
import type { SearchBackend } from 'arocapi';
import arocapi, { AllVisibleEntityFilter, AllVisibleSearchFilter, errorHandler, notFoundHandler } from 'arocapi';
import { EntityMetaMetadata } from 'arocapi/storage/entity-meta';
import Fastify, { type FastifyPluginAsync } from 'fastify';
import pkg from '../package.json' with { type: 'json' };
import { adminPages } from './admin/plugin.ts';
import { access, isAuthenticated } from './auth.ts';
import { config } from './configuration.ts';
import { logger } from './logger.ts';
import { oidcProvider } from './oidc/provider.ts';
import { prisma } from './prisma.ts';
import type { Repository } from './repository.ts';

type AppDeps = {
  repository: Repository;
  search: SearchBackend;
};

const ldacapi: FastifyPluginAsync = async (fastify) => {
  fastify.get('/version', async () => ({ version: pkg.version }));
};

export function buildApp({ repository, search }: AppDeps) {
  const fastify = Fastify({
    loggerInstance: logger,
    routerOptions: {
      maxParamLength: config.maxParamLength,
    },
    trustProxy: true, // Runs behind a reverse proxy, which must set the X-Forwarded-* headers
  });
  const prefix = config.prefix || '';

  fastify.setErrorHandler(errorHandler);
  fastify.setNotFoundHandler(notFoundHandler);
  fastify.register(fastifySensible);
  fastify.register(
    async (api) => {
      api.register(cors, { origin: '*', methods: ['GET', 'HEAD', 'POST'], maxAge: 2 * 60 * 60 });
      api.register(arocapi, {
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
      });
      api.register(ldacapi);
    },
    { prefix },
  );
  if (config.auth) {
    fastify.register(oidcProvider, { auth: config.auth });
    fastify.register(adminPages, { prefix: '/admin', auth: config.auth, adminUsers: config.adminUsers, repository });
  } else {
    fastify.log.warn('The admin pages are off because sign-in is off; set OIDC_UPSTREAM_ISSUER to turn them on');
  }

  return fastify;
}
