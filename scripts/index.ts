import { parseArgs } from 'node:util';
import { Client } from '@opensearch-project/opensearch';
import { config } from '../src/configuration.ts';
import { createIndexQueue } from '../src/index-queue/index-queue.ts';
import { indexerDeps } from '../src/indexer/deps.ts';
import { indexAndSummarise } from '../src/indexer/index-run.ts';
import { prisma } from '../src/prisma.ts';
import { openRepository } from '../src/repository/repository.ts';

const { values } = parseArgs({ options: { force: { type: 'boolean', default: false } } });

const opensearch = new Client({ node: config.opensearchUrl });
const repository = await openRepository(config.ocfl.root);
const indexQueue = createIndexQueue({ prisma, repository });
const { failed } = await indexAndSummarise(indexerDeps(repository, opensearch), indexQueue, () => indexQueue.indexEverything({ reindex: values.force }));
process.exitCode = failed.length > 0 ? 1 : 0;
await Promise.all([prisma.$disconnect(), opensearch.close()]);
