import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@opensearch-project/opensearch';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/configuration.ts';
import { createSearchBackend } from '../src/indexer/search.ts';
import { prisma } from '../src/prisma.ts';

const crateIds = [
  'arcp://name,bundled',
  'arcp://name,distributed_root',
  'arcp://name,distributed_content_restricted',
  'arcp://name,distributed_metadata_restricted',
];

describe('seed and index', () => {
  let storage: string;

  beforeAll(async () => {
    storage = await mkdtemp(join(tmpdir(), 'ldacapi-'));
    const env = { ...process.env, OCFL_ROOT: join(storage, 'ocfl'), LOG_LEVEL: 'silent' };
    execFileSync('node', ['scripts/seed.ts'], { env, stdio: 'ignore' });
    execFileSync('node', ['scripts/index.ts'], { env, stdio: 'ignore' });
  });

  afterAll(async () => {
    await rm(storage, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it('indexes every crate into the database', async () => {
    const entities = await prisma.entity.findMany({ where: { id: { in: crateIds } }, select: { id: true } });

    expect(entities.map((entity) => entity.id).sort()).toEqual([...crateIds].sort());
  });

  it('indexes every crate into OpenSearch', async () => {
    const opensearch = new Client({ node: config.opensearchUrl });
    const search = createSearchBackend(opensearch);
    const rows = await prisma.entity.findMany({ select: { id: true } });
    const ids = rows.map(({ id }) => id);
    expect(ids).toEqual(expect.arrayContaining(crateIds));

    // Documents are searchable after OpenSearch's next refresh
    await vi.waitFor(async () => {
      const { total } = await search.search({
        searchType: 'basic',
        query: '',
        filters: { terms: {}, ranges: {} },
        limit: 1,
        offset: 0,
        sort: 'relevance',
        order: 'asc',
        visibility: { id: { in: ids } },
      });
      expect(total).toBe(ids.length);
    });
    await opensearch.close();
  });
});
