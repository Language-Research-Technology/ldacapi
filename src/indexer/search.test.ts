import { type ApiResponse, type Client, errors } from '@opensearch-project/opensearch';
import { describe, expect, it } from 'vitest';
import { config } from '../configuration.ts';
import { SearchIndexer } from './search.ts';

const clientFailingWith = (type: string) =>
  ({
    cluster: { putSettings: async () => ({}) },
    indices: {
      create: async () => {
        throw new errors.ResponseError({ body: { error: { type } }, statusCode: 400 } as ApiResponse);
      },
    },
  }) as unknown as Client;

describe('SearchIndexer', () => {
  it('fails when it cannot create the index', async () => {
    const client = clientFailingWith('cluster_block_exception');

    await expect(SearchIndexer.create({ searchSettings: config.search, client })).rejects.toThrow('cluster_block_exception');
  });

  it('uses an index that already exists', async () => {
    const client = clientFailingWith('resource_already_exists_exception');

    await expect(SearchIndexer.create({ searchSettings: config.search, client })).resolves.toBeInstanceOf(SearchIndexer);
  });
});
