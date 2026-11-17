import { parseArgs } from 'node:util';
import { Client } from '@opensearch-project/opensearch';
import { config } from '../src/configuration.ts';
import { createIndexQueue } from '../src/index-queue/index-queue.ts';
import { workTheQueue } from '../src/indexer/indexer.ts';
import { logger } from '../src/logger.ts';
import { prisma } from '../src/prisma.ts';
import { openRepository } from '../src/repository/repository.ts';
import { createSearchBackend } from '../src/search-backend.ts';

const { values } = parseArgs({ options: { force: { type: 'boolean', default: false } } });

const opensearch = new Client({ node: config.opensearchUrl });
const repository = await openRepository(config.ocfl.root);
const indexQueue = createIndexQueue({ prisma, repository });
const asked = await indexQueue.indexEverything({ reindex: values.force });
await workTheQueue({ prisma, repository, opensearch, search: createSearchBackend(opensearch), licences: config }, { until: 'empty' });
const failed = await indexQueue.failures(asked);
for (const { crateId, error } of failed) {
  logger.error({ crateId, error }, 'Crate failed to index');
}
process.exitCode = failed.length > 0 ? 1 : 0;
await Promise.all([prisma.$disconnect(), opensearch.close()]);
