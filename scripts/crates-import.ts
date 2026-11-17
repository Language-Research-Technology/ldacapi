import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@opensearch-project/opensearch';
import { config } from '../src/configuration.ts';
import { importCrates } from '../src/crates-import.ts';
import { createIndexQueue } from '../src/index-queue/index-queue.ts';
import { workTheQueue } from '../src/indexer/indexer.ts';
import { logger } from '../src/logger.ts';
import { prisma } from '../src/prisma.ts';
import { openOrCreateRepository } from '../src/repository/repository.ts';
import { createSearchBackend } from '../src/search-backend.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, allowNegative: true, options: { index: { type: 'boolean', default: true } } });

const opensearch = new Client({ node: config.opensearchUrl });
const repository = await openOrCreateRepository(config.ocfl.root);
const indexing = values.index
  ? {
      indexQueue: createIndexQueue({ prisma, repository }),
      workTheQueue: () => workTheQueue({ prisma, repository, opensearch, search: createSearchBackend(opensearch), licences: config }, { until: 'empty' }),
    }
  : undefined;
process.exitCode = (await importCrates(repository, resolve(positionals[0] ?? 'test-data'), indexing)) ? 0 : 1;
logger.info({ root: config.ocfl.root }, 'Imported crates into the OCFL repository');
await Promise.all([prisma.$disconnect(), opensearch.close()]);
