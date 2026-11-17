import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestApp, ocflStorage } from './app.ts';

const BUNDLED = 'arcp://name,bundled';
const DISTRIBUTED = 'arcp://name,distributed_root';
const CONTENT_RESTRICTED = 'arcp://name,distributed_content_restricted';
const METADATA_RESTRICTED = 'arcp://name,distributed_metadata_restricted';
const OBJECT = 'http://pcdm.org/models#Object';

/** Oni's counts for the test data before aggregates were precomputed: collections, objects, subCollections, files */
const COUNTS: Record<string, [number, number, number, number]> = {
  [BUNDLED]: [2, 2, 2, 6],
  [`${BUNDLED}/ch1`]: [0, 1, 0, 1],
  [`${BUNDLED}/ch1/history`]: [0, 0, 0, 1],
  [`${BUNDLED}/ch2/facts`]: [0, 0, 0, 1],
  [`${BUNDLED}/intro`]: [0, 0, 0, 3],
  [CONTENT_RESTRICTED]: [0, 1, 0, 1],
  [`${CONTENT_RESTRICTED}/main`]: [0, 0, 0, 1],
  [METADATA_RESTRICTED]: [0, 1, 0, 1],
  [`${METADATA_RESTRICTED}/main`]: [0, 0, 0, 1],
  [DISTRIBUTED]: [2, 2, 2, 3],
};

const { ocflRoot } = ocflStorage();
let started: Awaited<ReturnType<typeof buildTestApp>>;

const get = async (path: string) => (await started.app.inject({ method: 'GET', url: `${started.config.prefix}${path}` })).json();

const entity = (id: string) => get(`/entity/${encodeURIComponent(id)}`);

beforeAll(async () => {
  started = await buildTestApp({ OCFL_ROOT: ocflRoot(), LOG_LEVEL: 'silent' }, { ocfl: true });
  await started.emptyEverything();
  await started.indexQueue.indexEverything();
  await started.workTheQueue();
});

afterAll(async () => {
  await started.emptyEverything();
  await started.app.close();
  await started.prisma.$disconnect();
});

describe('Oni entity fields', () => {
  it('count what is below each entity, across crates, as before aggregates were precomputed', async () => {
    const ids = (await started.prisma.entity.findMany({ select: { id: true } })).map(({ id }) => id);

    const counts = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, Object.values((await entity(id)).counts) as number[]] as const)));

    expect(Object.keys(counts)).toHaveLength(28);
    expect(Object.fromEntries(Object.entries(counts).filter(([, values]) => values.some((n) => n > 0)))).toEqual(COUNTS);
  });

  it('list the languages, communication modes and media types at or below an entity, by their search facet labels', async () => {
    expect(await entity(BUNDLED)).toMatchObject({
      language: ['English'],
      communicationMode: ['https://w3id.org/ldac/terms#WrittenLanguage'],
      // Not text/csv: its object is a member of nothing
      mediaType: ['application/pdf', 'image/jpeg', 'text/plain', 'video/mpeg'],
    });
  });

  it('pass on the accessControl the indexer stored', async () => {
    expect((await entity(DISTRIBUTED)).accessControl).toBe('Public');
    expect((await entity(`${CONTENT_RESTRICTED}/main`)).accessControl).toBe('AuthorizationByApplication');
  });

  it('leave out accessControl for an entity indexed without one', async () => {
    const id = `${BUNDLED}/unindexed`;
    await started.prisma.entity.create({
      data: { id, name: 'unindexed', description: '', entityType: OBJECT, metadataLicenseId: '', contentLicenseId: '' },
    });

    expect(await entity(id)).not.toHaveProperty('accessControl');
    await started.prisma.entity.delete({ where: { id } });
  });

  it('are read for a whole page of entities in one query', async () => {
    const read = vi.spyOn(started.prisma, '$queryRaw');

    const { entities } = await get(`/entities?memberOf=${encodeURIComponent(DISTRIBUTED)}`);

    expect(read.mock.calls.filter(([sql]) => String(sql).includes('FROM aggregate'))).toHaveLength(1);
    read.mockRestore();
    expect(entities.find(({ id }: { id: string }) => id === CONTENT_RESTRICTED)).toMatchObject({
      counts: { collections: 0, objects: 1, subCollections: 0, files: 1 },
      language: ['English'],
    });
  });
});
