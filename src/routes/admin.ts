import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import bearerAuthPlugin from '@fastify/bearer-auth';
import { z } from 'zod/v4';
import { getIndexerState, createIndex, deleteIndex } from '../indexer/ocfl.ts';

export const admin: FastifyPluginAsync<{ prefix: string; repository: any }> = async (fastify, opts) => {
  console.log(opts);
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.register(bearerAuthPlugin, { keys: ['abc'] });

  app.post('/index', async (request, reply) => reply.redirect('index/', 301));
  app.post('/index/:crateId/:type?',
    {
      schema: {
        params: z.object({
          crateId: z.string().optional(),
          type: z.string().optional(),
        }),
        querystring: z.object({ force: z.string().optional() })
      }
    }, async (request, reply) => {
      const { type, crateId } = request.params;
      const force = request.query.force != null;
      const state = await getIndexerState(crateId, type);
      if (state) {
        try {
          if (state.isIndexed && !crateId && !force) {
            throw fastify.httpErrors.conflict('Index already exists, no changes has been made.');
          } else if (state.isDeleting) {
            throw fastify.httpErrors.conflict('Deleting is in progress.');
          }
          if (!state.isIndexing) {
            app.log.debug(`running [${type}] indexer`);
            createIndex(opts.repository, crateId ? new RegExp('^' + crateId) : undefined, type, force);
          }
          return reply.status(202).send(state);
        } catch (e) {
          const err = e as Error;
          app.log.error(err);
          return fastify.httpErrors.internalServerError({ message: `Error indexing [${type}] ${err.message}`, stack: err.stack });
        }
      } else {
        throw fastify.httpErrors.notFound('Indexer does not exist');
      }
    }
  );

  app.get('/index', async (request, reply) => {
    return reply.send({ structural: [], opensearch: [] });
  });

  app.delete('/index', async (request, reply) => {
    deleteIndex();
    return reply.send({ message: 'Deleting' });
  });

  app.delete('/index/:type', {
    schema: {
      params: z.object({
        type: z.string().optional(),
      })
    }
  }, async (request, reply) => {
    const { type } = request.params;
    deleteIndex(type);
    return reply.send({ message: 'Deleting' });
  });

};