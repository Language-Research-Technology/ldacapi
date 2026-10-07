import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@opensearch-project/opensearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/configuration.ts';
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
    const indexed = await Promise.all(
      crateIds.map(async (id) => {
        const { body } = await opensearch.count({ index: config.search.entityIndex, body: { query: { term: { rocrateRootId: id } } } });
        return body.count > 0;
      }),
    );
    await opensearch.close();

    expect(indexed).toEqual(crateIds.map(() => true));
  });
});
