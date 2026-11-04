import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ocflRepository } from '../test/admin.ts';
import { buildTestApp } from '../test/app.ts';

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
  execFileSync('node', ['scripts/crates-import.ts'], { env: { ...process.env, OCFL_ROOT: ocflRoot, LOG_LEVEL: 'silent' }, stdio: 'ignore' });
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

describe('search by recordType and entityType', () => {
  it('declares a recordType facet, and entityType as a filter only', async () => {
    const response = await started.app.inject({ method: 'GET', url: `${started.config.prefix}/capabilities` });

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
      await started.app.inject({ method: 'GET', url: `${started.config.prefix}/entities?entityType=${encodeURIComponent(OBJECT)}&limit=100` })
    ).json();

    expect(total).toBeGreaterThan(0);
    expect(entities.every(({ entityType }: { entityType: string }) => entityType === OBJECT)).toBe(true);
    expect(entities.map(({ id }: { id: string }) => id).sort()).toEqual(listed.entities.map(({ id }: { id: string }) => id).sort());
  });
});
