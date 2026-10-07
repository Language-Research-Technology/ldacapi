import { Client } from '@opensearch-project/opensearch';
import { config } from '../src/configuration.ts';
import { createIndex, init } from '../src/ocfl.ts';
import { prisma } from '../src/prisma.ts';

const opensearch = new Client({ node: config.opensearchUrl });
await init({ opensearchClient: opensearch });
await createIndex(undefined, undefined, true);
await Promise.all([prisma.$disconnect(), opensearch.close()]);
