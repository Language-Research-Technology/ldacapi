import bearerAuthPlugin from '@fastify/bearer-auth';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
//import { getIndexerState, createIndex, deleteIndex } from '../ocfl.ts';
import { config } from '../configuration.ts';
import { type Repository, State } from '../repository.ts';

export const admin: FastifyPluginAsync<{ prefix: string; repository: Repository }> = async (fastify, opts) => {
  const repo = opts.repository;
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.register(bearerAuthPlugin, { keys: [config.tokenAdmin] });

  app.get('/repository/', async (_request, reply) => reply.redirect('index/', 301));
  app.get('/repository', async (_request, reply) => reply.redirect('index/', 301));

  app.get(
    '/index/:crateId?',
    {
      schema: {
        summary: 'Get the state of the indexes for a given crate or all crates if no crateId is specified.',
        params: z.object({
          crateId: z.string().optional(),
        }),
        querystring: z.object({
          refresh: z.coerce.boolean().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { crateId } = request.params;
      const { refresh } = request.query;
      const objects = [];
      for await (const repoObject of repo.objects(crateId, refresh)) {
        objects.push(repoObject);
      }
      if (objects.length > 0) {
        return reply.send(objects);
      } else {
        return reply.notFound('Index not found');
      }
    },
  );

  app.post('/index', async (_request, reply) => reply.redirect('index/', 301));
  app.post(
    '/index/:crateId/:type?',
    {
      schema: {
        summary: 'Index all creates or a specified crate from the OCFL repository.',
        description: 'If the index already exists, it will not be re-indexed unless the "force" query parameter is set to true.',
        params: z.object({
          crateId: z.string().optional(),
          type: z.string().optional(),
        }),
        querystring: z.object({ force: z.string().optional() }),
      },
    },
    async (request, reply) => {
      const { type, crateId } = request.params;
      const force = request.query.force != null;
      const state = crateId ? await repo.getState(crateId, type) : {};
      if (state) {
        if (type && state[type] === State.INDEXED && !force) {
          throw fastify.httpErrors.conflict('Index already exists, no changes has been made.');
        } else if (type && state[type] === State.DELETING) {
          throw fastify.httpErrors.conflict('Deleting is in progress.');
        }
        repo
          .createIndex(crateId ? new RegExp(`^${crateId}`) : undefined, type, force)
          .catch((err) => request.log.error({ err, crateId, type }, 'Indexing failed'));
        return reply.status(202).send(State.QUEUED);
      } else {
        throw fastify.httpErrors.notFound('Indexer does not exist');
      }
    },
  );

  app.delete('/index', async (_request, reply) => reply.redirect('index/*', 301));
  app.delete(
    '/index/:crateId/:type?',
    {
      schema: {
        summary: 'Delete the index of all creates or a specified crate.',
        params: z.object({
          crateId: z.string().optional(),
          type: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      let { crateId, type } = request.params;
      if (crateId === 'all' || crateId === '*') {
        crateId = undefined;
      }
      repo.deleteIndex(crateId, type).catch((err) => request.log.error({ err, crateId, type }, 'Deleting index failed'));
      return reply.send({ message: 'Deleting' });
    },
  );
};
