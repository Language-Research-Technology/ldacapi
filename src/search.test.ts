import { beforeAll, describe, expect, it } from 'vitest';
import { ocflTestbed } from '../test/app.ts';

const OBJECT = 'http://pcdm.org/models#Object';
const MEDIA = 'http://schema.org/MediaObject';
const BUNDLED = 'arcp://name,bundled';

const testbed = ocflTestbed();
const { search } = testbed;

beforeAll(async () => {
  await testbed.started.repository.deleteIndex();
  await testbed.started.repository.createIndex(BUNDLED);
});

describe('search by recordType and entityType', () => {
  it('declares a recordType facet, and entityType as a filter only', async () => {
    const response = await testbed.started.app.inject({ method: 'GET', url: `${testbed.started.config.prefix}/capabilities` });

    const { facets, filters } = response.json().search;
    expect(facets).toHaveProperty('recordType');
    expect(facets).not.toHaveProperty('entityType');
    expect(facets).not.toHaveProperty('type');
    expect(filters).toHaveProperty('entityType');
  });

  it("facets on a readable label for each entity's class", async () => {
    const { facets } = await search({ query: '' });

    expect(facets).not.toHaveProperty('entityType');
    const names = facets.recordType.map(({ name }: { name: string }) => name);
    expect(names).toEqual(expect.arrayContaining(['Collection', 'Object', 'File']));
    expect(names.some((name: string) => name.includes('://'))).toBe(false);
  });

  it('filters on recordType', async () => {
    const { total, entities } = await search({ query: '', filters: { recordType: ['File'] }, limit: 100 });

    expect(total).toBeGreaterThan(0);
    expect(entities.every(({ entityType }: { entityType: string }) => entityType === MEDIA)).toBe(true);
  });

  it('filters on entityType, agreeing with listing entities by entityType', async () => {
    const { total, entities } = await search({ query: '', filters: { entityType: [OBJECT] }, limit: 100 });
    const listed = (
      await testbed.started.app.inject({ method: 'GET', url: `${testbed.started.config.prefix}/entities?entityType=${encodeURIComponent(OBJECT)}&limit=100` })
    ).json();

    expect(total).toBeGreaterThan(0);
    expect(entities.every(({ entityType }: { entityType: string }) => entityType === OBJECT)).toBe(true);
    expect(entities.map(({ id }: { id: string }) => id).sort()).toEqual(listed.entities.map(({ id }: { id: string }) => id).sort());
  });
});
