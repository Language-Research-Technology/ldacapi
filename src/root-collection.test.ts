import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ocflRepository } from '../test/admin.ts';
import { buildTestApp } from '../test/app.ts';

const BUNDLED = 'arcp://name,bundled';
const ROOT = 'arcp://name,distributed_root';
const CONTENT = 'arcp://name,distributed_content_restricted';
const METADATA = 'arcp://name,distributed_metadata_restricted';

let storage: string;
let started: Awaited<ReturnType<typeof buildTestApp>>;

const rootCollectionOf = async (id: string) => {
  const response = await started.app.inject({ method: 'GET', url: `${started.config.prefix}/entity/${encodeURIComponent(id)}` });
  expect(response.statusCode).toBe(200);
  return response.json().rootCollection?.id ?? null;
};

const collectionFacet = async () => {
  const response = await started.app.inject({ method: 'POST', url: `${started.config.prefix}/search`, payload: { query: '' } });
  expect(response.statusCode).toBe(200);
  return response.json().facets.rootCollection.map(({ name }: { name: string }) => name);
};

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), 'ldacapi-root-collection-'));
  const ocflRoot = join(storage, 'ocfl');
  execFileSync('node', ['scripts/seed.ts'], { env: { ...process.env, OCFL_ROOT: ocflRoot, LOG_LEVEL: 'silent' }, stdio: 'ignore' });
  started = await buildTestApp({ OCFL_ROOT: ocflRoot, LOG_LEVEL: 'silent' }, { repository: ocflRepository });
});

afterAll(async () => {
  await started?.repository.deleteIndex();
  await started?.app.close();
  await started?.prisma.$disconnect();
  await rm(storage, { recursive: true, force: true });
});

describe.each([
  ['before', [ROOT, CONTENT, METADATA, BUNDLED]],
  ['after', [CONTENT, METADATA, ROOT, BUNDLED]],
])('rootCollection, with the distributed parent crate indexed %s its children', (_order, crates) => {
  beforeAll(async () => {
    await started.repository.deleteIndex();
    await started.repository.createIndex(crates);
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
