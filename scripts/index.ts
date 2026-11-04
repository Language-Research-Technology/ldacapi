import { Client } from '@opensearch-project/opensearch';
import { config } from '../src/configuration.ts';
import { createIndex, deleteIndex, init } from '../src/ocfl.ts';
import { prisma } from '../src/prisma.ts';

const opensearch = new Client({ node: config.opensearchUrl });
await init({ opensearchClient: opensearch });
// A full rebuild, as deleting by crate misses rows that don't record their crate
await deleteIndex();
await createIndex();
await Promise.all([prisma.$disconnect(), opensearch.close()]);
