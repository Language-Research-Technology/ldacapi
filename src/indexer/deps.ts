import type { StorageRoot } from '@ocfl/ocfl-fs';
import type { Client } from '@opensearch-project/opensearch';
import { config } from '../configuration.ts';
import { prisma } from '../prisma.ts';
import { createSearchBackend } from '../search-backend.ts';
import type { IndexerDeps } from './indexer.ts';

/** What indexing `repository` through `opensearch` needs, the rest from configuration */
export const indexerDeps = (repository: StorageRoot, opensearch: Client): IndexerDeps => ({
  prisma,
  repository,
  opensearch,
  search: createSearchBackend(opensearch),
  licences: config,
});
