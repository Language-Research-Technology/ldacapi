import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ocflRepository } from '../test/admin.ts';
import { buildTestApp } from '../test/app.ts';

const logs = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('./logger.ts', async () => {
  const { pino } = await import('pino');
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logs.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return { logger: pino({ level: 'info' }, stream) };
});

const ROOT = 'arcp://name,unwritable';
const WRITTEN = `${ROOT}/written`;
// Postgres can't store a NUL character, so this entity's row fails to be written
const UNWRITTEN = `${ROOT}/unwritten`;
const LICENSE = { '@id': 'https://creativecommons.org/licenses/by/4.0/' };
const OBJECT = { '@id': 'https://w3id.org/ldac/profile#Object' };

const crate = {
  '@context': ['https://w3id.org/ro/crate/1.1/context', 'https://w3id.org/ldac/context', { '@vocab': 'http://schema.org/' }],
  '@graph': [
    { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', license: LICENSE, about: { '@id': ROOT } },
    {
      '@id': ROOT,
      '@type': ['Dataset', 'RepositoryCollection'],
      conformsTo: { '@id': 'https://w3id.org/ldac/profile#Collection' },
      name: 'Unwritable',
      license: LICENSE,
    },
    { '@id': WRITTEN, '@type': 'RepositoryObject', conformsTo: OBJECT, memberOf: { '@id': ROOT }, name: 'Written' },
    { '@id': UNWRITTEN, '@type': 'RepositoryObject', conformsTo: OBJECT, memberOf: { '@id': ROOT }, name: 'Unwritten\u0000' },
  ],
};

let storage: string;
let started: Awaited<ReturnType<typeof buildTestApp>>;

const search = async (body: Record<string, unknown>) => {
  const response = await started.app.inject({ method: 'POST', url: `${started.config.prefix}/search`, payload: body });
  expect(response.statusCode).toBe(200);
  return response.json();
};

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), 'ldacapi-search-total-'));
  const source = join(storage, 'crates');
  await mkdir(join(source, 'unwritable'), { recursive: true });
  await writeFile(join(source, 'unwritable', 'ro-crate-metadata.json'), JSON.stringify(crate));
  const ocflRoot = join(storage, 'ocfl');
  execFileSync('node', ['scripts/seed.ts', source], { env: { ...process.env, OCFL_ROOT: ocflRoot, LOG_LEVEL: 'silent' }, stdio: 'ignore' });
  started = await buildTestApp({ OCFL_ROOT: ocflRoot, LOG_LEVEL: 'silent' }, { repository: ocflRepository });
  await started.repository.deleteIndex();
  await started.repository.createIndex(ROOT);
});

afterAll(async () => {
  await started?.repository.deleteIndex();
  await started?.app.close();
  await started?.prisma.$disconnect();
  await rm(storage, { recursive: true, force: true });
});

describe('an entity whose row fails to be written', () => {
  it('is not counted by search', async () => {
    const { total, entities, facets } = await search({ query: '', limit: 100 });

    expect(entities.map(({ id }: { id: string }) => id).sort()).toEqual([ROOT, WRITTEN]);
    expect(total).toBe(2);
    expect(facets.entityType.reduce((sum: number, { count }: { count: number }) => sum + count, 0)).toBe(2);
  });

  it('is not counted when the search index is rebuilt alone', async () => {
    await started.repository.createIndex(ROOT, 'search', true);

    const { total, entities } = await search({ query: '', limit: 100 });

    expect(entities.map(({ id }: { id: string }) => id).sort()).toEqual([ROOT, WRITTEN]);
    expect(total).toBe(2);
  });

  it('logs the skip with the crate and entity ids', () => {
    expect(logs).toContainEqual(expect.objectContaining({ level: 40, crateId: ROOT, entityId: UNWRITTEN, msg: 'Skipped: no database row' }));
  });
});
