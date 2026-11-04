import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ocflRepository } from '../test/admin.ts';
import { buildTestApp } from '../test/app.ts';

const COLLECTION = 'http://pcdm.org/models#Collection';
const OBJECT = 'http://pcdm.org/models#Object';
const MEDIA = 'http://schema.org/MediaObject';
const BUNDLED = 'arcp://name,bundled';

let storage: string;
let started: Awaited<ReturnType<typeof buildTestApp>>;

const search = async (body: Record<string, unknown>) => {
  const response = await started.app.inject({ method: 'POST', url: `${started.config.prefix}/search`, payload: body });
  expect(response.statusCode).toBe(200);
  return response.json();
};

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), 'ldacapi-search-'));
  const ocflRoot = join(storage, 'ocfl');
  execFileSync('node', ['scripts/seed.ts'], { env: { ...process.env, OCFL_ROOT: ocflRoot, LOG_LEVEL: 'silent' }, stdio: 'ignore' });
  started = await buildTestApp({ OCFL_ROOT: ocflRoot, LOG_LEVEL: 'silent' }, { repository: ocflRepository });
  await started.repository.deleteIndex();
  await started.repository.createIndex(BUNDLED);
});

afterAll(async () => {
  await started?.repository.deleteIndex();
  await started?.app.close();
  await started?.prisma.$disconnect();
  await rm(storage, { recursive: true, force: true });
});

describe('search by entityType', () => {
  it('declares an entityType facet and no type facet', async () => {
    const response = await started.app.inject({ method: 'GET', url: `${started.config.prefix}/capabilities` });

    const { facets } = response.json().search;
    expect(facets).toHaveProperty('entityType');
    expect(facets).not.toHaveProperty('type');
  });

  it("facets on each entity's class URI", async () => {
    const { facets } = await search({ query: '' });

    const names = facets.entityType.map(({ name }: { name: string }) => name);
    expect(names).toEqual(expect.arrayContaining([COLLECTION, OBJECT, MEDIA]));
    expect(names.every((name: string) => /^https?:\/\//.test(name))).toBe(true);
  });

  it('filters on entityType, agreeing with listing entities by entityType', async () => {
    const { total, entities } = await search({ query: '', filters: { entityType: [OBJECT] }, limit: 100 });
    const listed = (
      await started.app.inject({ method: 'GET', url: `${started.config.prefix}/entities?entityType=${encodeURIComponent(OBJECT)}&limit=100` })
    ).json();

    expect(total).toBeGreaterThan(0);
    expect(entities.every(({ entityType }: { entityType: string }) => entityType === OBJECT)).toBe(true);
    expect(entities.map(({ id }: { id: string }) => id).sort()).toEqual(listed.entities.map(({ id }: { id: string }) => id).sort());
  });
});
