import { Client } from '@opensearch-project/opensearch';
import { buildApp } from './app.ts';
import { config } from './configuration.ts';
import { createIndexQueue } from './index-queue/index-queue.ts';
import { prisma } from './prisma.ts';
import { contentStorage, openRepository } from './repository/repository.ts';
import { createSearchBackend } from './search-backend.ts';

const search = createSearchBackend(new Client({ node: config.opensearchUrl }));
const repository = await openRepository(config.ocfl.root);
const fastify = buildApp({ search, storage: await contentStorage(config.ocfl.root), indexQueue: createIndexQueue({ prisma, repository }) });

try {
  await fastify.listen({ port: config.port, host: config.host });
} catch (err) {
  fastify.log.error({ err }, 'Failed to start server');
  process.exit(1);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    fastify.log.info({ signal }, 'Shutting down');
    await fastify.close();
    process.exit(0);
  });
}
