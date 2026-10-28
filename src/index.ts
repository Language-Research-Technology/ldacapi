import { Client } from '@opensearch-project/opensearch';
import { buildApp } from './app.ts';
import { config } from './configuration.ts';
import { createSearchBackend } from './indexer/search.ts';
import { initRepository } from './repository.ts';

const opensearch = new Client({ node: config.opensearchUrl });
const search = createSearchBackend(opensearch);
const repository = await initRepository('ocfl', { opensearchClient: opensearch, search });
const fastify = buildApp({ repository, search });

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
