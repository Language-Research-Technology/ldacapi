import type { FastifyPluginAsync } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import pkg from '../package.json' with { type: 'json' };
import type { Repository } from './repository.ts';
import { admin as adminRoute } from './routes/admin.ts';

export type LdacapiOptions = {
  repository: Repository;
};

const ldacapi: FastifyPluginAsync<LdacapiOptions> = async (fastify, options: LdacapiOptions) => {
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);
  const { version } = pkg;
  fastify.register(adminRoute, { prefix: '/admin', repository: options.repository });

  fastify.get('/version', async () => ({ version }));
};

export default ldacapi;
