import type { StorageRoot } from '@ocfl/ocfl-fs';
import { Client } from '@opensearch-project/opensearch';
import { isOpenLicence } from '../access/licences.ts';
import { config } from '../configuration.ts';
import { createIndexQueue } from '../index-queue/index-queue.ts';
import { prisma } from '../prisma.ts';
import { openOrCreateRepository, openRepository } from '../repository/repository.ts';
import { createSearchBackend } from '../search-backend.ts';
import type { IndexerDeps } from './indexer.ts';

/** What indexing `repository` through `opensearch` needs, the rest from configuration */
export const indexerDeps = (repository: StorageRoot, opensearch: Client): IndexerDeps => ({
  prisma,
  repository,
  opensearch,
  search: createSearchBackend(opensearch),
  licences: { defaultLicense: config.defaultLicense, defaultMetadataLicense: config.defaultMetadataLicense, isOpenLicence },
});

/**
 * Opens the configured repository, creating it empty with `create`, and search, for a process that indexes or asks for
 * index jobs. `close` disconnects from the database and search
 */
export async function openIndexing({ create = false } = {}) {
  const repository = await (create ? openOrCreateRepository : openRepository)(config.ocfl.root);
  const opensearch = new Client({ node: config.opensearchUrl });
  return {
    repository,
    deps: indexerDeps(repository, opensearch),
    indexQueue: createIndexQueue({ prisma, repository }),
    close: async () => {
      await Promise.all([prisma.$disconnect(), opensearch.close()]);
    },
  };
}
