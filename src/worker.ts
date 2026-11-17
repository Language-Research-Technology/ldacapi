import { Client } from '@opensearch-project/opensearch';
import { config } from './configuration.ts';
import { workTheQueue } from './indexer/indexer.ts';
import { logger } from './logger.ts';
import { prisma } from './prisma.ts';
import { openRepository } from './repository/repository.ts';
import { createSearchBackend } from './search-backend.ts';

const opensearch = new Client({ node: config.opensearchUrl });
const repository = await openRepository(config.ocfl.root);
const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'Stopping, releasing the current job');
    stop.abort();
  });
}

logger.info('Worker started');
await workTheQueue({ prisma, repository, opensearch, search: createSearchBackend(opensearch), licences: config }, { until: 'aborted', signal: stop.signal });
await Promise.all([prisma.$disconnect(), opensearch.close()]);
