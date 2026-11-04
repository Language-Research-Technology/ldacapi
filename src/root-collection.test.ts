import { beforeAll, describe, expect, it } from 'vitest';
import { ocflTestbed } from '../test/app.ts';

const BUNDLED = 'arcp://name,bundled';
const ROOT = 'arcp://name,distributed_root';
const CONTENT = 'arcp://name,distributed_content_restricted';
const METADATA = 'arcp://name,distributed_metadata_restricted';

const testbed = ocflTestbed();

const rootCollectionOf = async (id: string) => {
  const { app, config } = testbed.started;
  const response = await app.inject({ method: 'GET', url: `${config.prefix}/entity/${encodeURIComponent(id)}` });
  expect(response.statusCode).toBe(200);
  return response.json().rootCollection?.id ?? null;
};

const collectionFacet = async () => (await testbed.search({ query: '' })).facets.rootCollection.map(({ name }: { name: string }) => name);

describe.each([
  ['before', [ROOT, CONTENT, METADATA, BUNDLED]],
  ['after', [CONTENT, METADATA, ROOT, BUNDLED]],
])('rootCollection, with the distributed parent crate indexed %s its children', (_order, crates) => {
  beforeAll(async () => {
    await testbed.started.repository.deleteIndex();
    await testbed.started.repository.createIndex(crates);
  });

  it('is empty on a top-level collection', async () => {
    expect(await rootCollectionOf(ROOT)).toBeNull();
    expect(await rootCollectionOf(BUNDLED)).toBeNull();
  });

  it("is the distributed collection's root for the entities of its nested crates", async () => {
    for (const id of [CONTENT, `${CONTENT}/main`, METADATA, `${METADATA}/main`]) {
      expect(await rootCollectionOf(id)).toBe(ROOT);
    }
  });

  it("is a stand-alone crate's root for its other entities", async () => {
    expect(await rootCollectionOf(`${BUNDLED}/ch1`)).toBe(BUNDLED);
  });

  it('lists the distributed collection once in the Collection facet', async () => {
    const names = await collectionFacet();

    expect(names.filter((name: string) => name === ROOT)).toHaveLength(1);
    expect(names).not.toContain(CONTENT);
    expect(names).not.toContain(METADATA);
  });
});
