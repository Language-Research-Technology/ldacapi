import { Client } from '@opensearch-project/opensearch';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from './configuration.ts';
import { createSearchBackend, deleteSearchIndex, prepareSearchIndex, type SearchBackend } from './search-backend.ts';

const opensearch = new Client({ node: config.opensearchUrl });
const search = createSearchBackend(opensearch);

/** Search whose first attempt to create the index fails with `error`, once another worker has created it */
const raced = (error: Error): SearchBackend => {
  let tries = 0;
  return {
    ...search,
    createIndex: async () => {
      await search.createIndex();
      if (tries++ === 0) {
        throw error;
      }
    },
  };
};

beforeEach(async () => {
  await deleteSearchIndex(opensearch);
});

afterAll(async () => {
  await opensearch.close();
});

describe('preparing the search index', () => {
  it('succeeds when another worker creates the index first', async () => {
    const exists = Object.assign(new Error('exists'), { meta: { body: { error: { type: 'resource_already_exists_exception' } } } });

    await expect(prepareSearchIndex(opensearch, raced(exists))).resolves.toBeUndefined();
  });

  it('fails when creating the index fails for another reason', async () => {
    await expect(prepareSearchIndex(opensearch, raced(new Error('Refused')))).rejects.toThrow('Refused');
  });
});
