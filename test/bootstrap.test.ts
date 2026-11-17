import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@opensearch-project/opensearch';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/configuration.ts';
import { prisma } from '../src/prisma.ts';
import { collection, crate, writeCrates } from './crate-builder.ts';

const crateIds = [
  'arcp://name,bundled',
  'arcp://name,distributed_root',
  'arcp://name,distributed_content_restricted',
  'arcp://name,distributed_metadata_restricted',
];

const emptyEverything = () => prisma.$executeRaw`TRUNCATE index_job, crate, index_worker, file, entity CASCADE`;

/** A new OCFL repository, imported from `source` (test-data by default), and how to run `pnpm index` over it */
const repository = () => {
  let storage: string;
  const env = () => ({ ...process.env, OCFL_ROOT: join(storage, 'ocfl'), LOG_LEVEL: 'silent', DEFAULT_LICENSE: '' });
  return {
    async create(source?: (scratch: string) => Promise<string>) {
      storage = await mkdtemp(join(tmpdir(), 'ldacapi-'));
      const sources = source ? [await source(storage)] : [];
      execFileSync('node', ['scripts/crates-import.ts', ...sources], { env: env(), stdio: 'ignore' });
    },
    index: (...args: string[]) => spawnSync('node', ['scripts/index.ts', ...args], { env: env(), stdio: 'ignore' }).status,
    remove: () => rm(storage, { recursive: true, force: true }),
  };
};

afterAll(async () => {
  await emptyEverything();
  await prisma.$disconnect();
});

describe('import and index', () => {
  const testData = repository();
  let status: number | null;

  beforeAll(async () => {
    await emptyEverything();
    await testData.create();
    status = testData.index();
  });

  afterAll(() => testData.remove());

  it('exits successfully', () => {
    expect(status).toBe(0);
  });

  it('indexes every crate into the database', async () => {
    const entities = await prisma.entity.findMany({ where: { id: { in: crateIds } }, select: { id: true } });

    expect(entities.map((entity) => entity.id).sort()).toEqual([...crateIds].sort());
  });

  it('indexes every crate into OpenSearch', async () => {
    const opensearch = new Client({ node: config.opensearchUrl });
    const rows = await prisma.entity.findMany({ select: { id: true } });
    const ids = rows.map(({ id }) => id);
    expect(ids).toEqual(expect.arrayContaining(crateIds));

    // Documents are searchable after OpenSearch's next refresh
    await vi.waitFor(async () => {
      const { body } = await opensearch.count({ index: config.search.entityIndex, body: { query: { ids: { values: ids } } } });
      expect(body.count).toBe(ids.length);
    });
    await opensearch.close();
  });

  it('records each crate as indexed at its head version', async () => {
    const records = await prisma.crateRecord.findMany({ where: { id: { in: crateIds } } });

    expect(records.map(({ indexedVersion }) => indexedVersion)).toEqual(crateIds.map(() => 1));
  });

  it('leaves indexed crates alone, unless forced to reindex them', async () => {
    const indexedAt = async () => (await prisma.crateRecord.findUniqueOrThrow({ where: { id: 'arcp://name,bundled' } })).indexedAt;
    const before = await indexedAt();

    expect(testData.index()).toBe(0);
    expect(await indexedAt()).toEqual(before);

    expect(testData.index('--force')).toBe(0);
    expect(await indexedAt()).not.toEqual(before);
  });
});

describe('index, when a crate fails', () => {
  const FAILING = 'arcp://name,no-licence';
  const failing = repository();

  beforeAll(async () => {
    await emptyEverything();
    await failing.create(async (scratch) => {
      const source = join(scratch, 'crates');
      await writeCrates(source, [crate(collection(FAILING, { licence: null })), crate(collection('arcp://name,licensed'))]);
      return source;
    });
  });

  afterAll(() => failing.remove());

  it('exits with an error, once it has indexed the rest', async () => {
    expect(failing.index()).toBe(1);

    const records = await prisma.crateRecord.findMany({ orderBy: { id: 'asc' } });
    expect(records.map(({ id, indexedVersion }) => [id, indexedVersion])).toEqual([
      ['arcp://name,licensed', 1],
      [FAILING, null],
    ]);
  });
});
