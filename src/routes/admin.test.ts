import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@opensearch-project/opensearch';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const BUNDLED = 'arcp://name,bundled';
const PEOPLE = 'arcp://name,people';

let storage: string;
let app: ReturnType<typeof import('../app.ts').buildApp>;
let opensearch: Client;
let config: typeof import('../configuration.ts').config;
let prisma: typeof import('../prisma.ts').prisma;
let repository: import('../repository.ts').Repository;

const admin = (method: 'GET' | 'POST' | 'DELETE', path: string) =>
  app.inject({ method, url: `${config.prefix}/admin/index/${path}`, headers: { authorization: `Bearer ${config.tokenAdmin}` } });

const entityCount = (crateId: string) => prisma.entity.count({ where: { rootCollection: crateId } });

const searchCount = async (crateId: string) => {
  await opensearch.indices.refresh({ index: config.search.entityIndex, ignore_unavailable: true });
  const { body } = await opensearch.count({
    index: config.search.entityIndex,
    ignore_unavailable: true,
    body: { query: { term: { rootCollection: crateId } } },
  });
  return body.count;
};

const waitUntilIndexed = (...crateIds: string[]) =>
  vi.waitFor(
    async () => {
      const objects: { id: string; state: unknown }[] = (await admin('GET', '')).json();
      const states = crateIds.map((id) => objects.find((object) => object.id === id)?.state);
      expect(states).toEqual(crateIds.map(() => ({ structural: 'indexed', search: 'indexed' })));
    },
    { timeout: 10_000, interval: 100 },
  );

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), 'ldacapi-admin-'));
  process.env.OCFL_ROOT = join(storage, 'ocfl');
  execFileSync('node', ['scripts/seed.ts'], { env: process.env, stdio: 'ignore' });

  // Imported after OCFL_ROOT is set, as configuration is read on import
  ({ config } = await import('../configuration.ts'));
  ({ prisma } = await import('../prisma.ts'));
  const { Client } = await import('@opensearch-project/opensearch');
  const { createSearchBackend } = await import('../indexer/search.ts');
  const { initRepository } = await import('../repository.ts');
  const { buildApp } = await import('../app.ts');

  opensearch = new Client({ node: config.opensearchUrl });
  const search = createSearchBackend(opensearch);
  repository = await initRepository('ocfl', { opensearchClient: opensearch, search });
  app = buildApp({ repository, search });
});

beforeEach(async () => {
  await repository.deleteIndex();
});

afterAll(async () => {
  await app.close();
  await opensearch.close();
  await prisma.$disconnect();
  await rm(storage, { recursive: true, force: true });
});

describe('admin indexing', () => {
  it('rejects requests without the admin token', async () => {
    const response = await app.inject({ method: 'POST', url: `${config.prefix}/admin/index/${encodeURIComponent(BUNDLED)}` });

    expect(response.statusCode).toBe(401);
  });

  it('indexes a single object', async () => {
    const response = await admin('POST', encodeURIComponent(BUNDLED));

    expect(response.statusCode).toBe(202);
    await waitUntilIndexed(BUNDLED);
    expect(await entityCount(PEOPLE)).toBe(0);
    expect(await searchCount(PEOPLE)).toBe(0);
  });

  it('indexes all objects', async () => {
    const response = await admin('POST', '');

    expect(response.statusCode).toBe(202);
    await waitUntilIndexed(BUNDLED, PEOPLE);
  });

  it('deletes the index of a single object', async () => {
    await admin('POST', '');
    await waitUntilIndexed(BUNDLED, PEOPLE);

    await admin('DELETE', encodeURIComponent(BUNDLED));

    await vi.waitFor(async () => {
      expect(await entityCount(BUNDLED)).toBe(0);
      expect(await searchCount(BUNDLED)).toBe(0);
    });
    expect(await entityCount(PEOPLE)).toBeGreaterThan(0);
    expect(await searchCount(PEOPLE)).toBeGreaterThan(0);
  });
});
