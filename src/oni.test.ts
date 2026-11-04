import { Client } from '@opensearch-project/opensearch';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { repository } from '../test/app.ts';
import { buildApp } from './app.ts';
import { config } from './configuration.ts';
import { createSearchBackend } from './indexer/search.ts';
import { COLLECTION, OBJECT } from './oni.ts';
import { prisma } from './prisma.ts';

const MEDIA = 'http://schema.org/MediaObject';
const PERSON = 'http://schema.org/Person';
const LICENCE = 'https://creativecommons.org/licenses/by/4.0/';

const ROOT = 'arcp://name,oni-test';
// A distributed crate: its own root collection, a member of ROOT
const SUB = 'arcp://name,oni-test-sub';

type Fixture = { id: string; entityType: string; memberOf: string | null; hasFile?: boolean };

const ENTITIES: Fixture[] = [
  { id: ROOT, entityType: COLLECTION, memberOf: null },
  { id: SUB, entityType: COLLECTION, memberOf: ROOT },
  { id: `${SUB}/object`, entityType: OBJECT, memberOf: SUB },
  { id: `${SUB}/object/a.wav`, entityType: MEDIA, memberOf: `${SUB}/object`, hasFile: true },
  { id: `${SUB}/object/b.txt`, entityType: MEDIA, memberOf: `${SUB}/object`, hasFile: true },
  { id: `${ROOT}/object`, entityType: OBJECT, memberOf: ROOT },
  { id: `${ROOT}/object/c.txt`, entityType: MEDIA, memberOf: `${ROOT}/object`, hasFile: true },
  { id: `${ROOT}/person`, entityType: PERSON, memberOf: ROOT },
];

const app = buildApp({ repository, search: createSearchBackend(new Client({ node: config.opensearchUrl })) });

const entity = async (id: string) => (await app.inject({ method: 'GET', url: `${config.prefix}/entity/${encodeURIComponent(id)}` })).json();

beforeAll(async () => {
  for (const { id, entityType, memberOf, hasFile } of ENTITIES) {
    await prisma.entity.create({
      data: {
        id,
        name: id,
        description: '',
        entityType,
        memberOf,
        rootCollection: id.startsWith(SUB) ? SUB : ROOT,
        metadataLicenseId: LICENCE,
        contentLicenseId: LICENCE,
        meta: id === ROOT ? { accessControl: 'Public' } : { accessControl: 'AuthorizationByApplication' },
      },
    });
    if (hasFile) {
      await prisma.file.create({ data: { id, filename: id, mediaType: 'text/plain', size: 1 } });
    }
  }
  await prisma.entity.create({
    data: { id: `${ROOT}/unindexed`, name: 'unindexed', description: '', entityType: OBJECT, metadataLicenseId: LICENCE, contentLicenseId: LICENCE },
  });
});

afterAll(async () => {
  const ids = [...ENTITIES.map(({ id }) => id), `${ROOT}/unindexed`];
  await prisma.file.deleteMany({ where: { id: { in: ids } } });
  await prisma.entity.deleteMany({ where: { id: { in: ids } } });
  await app.close();
});

describe('Oni entity fields', () => {
  it('counts what is under a collection, following memberOf into other crates', async () => {
    expect((await entity(ROOT)).counts).toEqual({ collections: 1, objects: 2, subCollections: 1, files: 3 });
    expect((await entity(SUB)).counts).toEqual({ collections: 0, objects: 1, subCollections: 0, files: 2 });
  });

  it('counts the files of an object', async () => {
    expect((await entity(`${SUB}/object`)).counts).toEqual({ collections: 0, objects: 0, subCollections: 0, files: 2 });
  });

  it('counts nothing under a file', async () => {
    expect((await entity(`${SUB}/object/a.wav`)).counts).toEqual({ collections: 0, objects: 0, subCollections: 0, files: 0 });
  });

  it('passes on the accessControl the indexer stored', async () => {
    expect((await entity(ROOT)).accessControl).toBe('Public');
    expect((await entity(`${SUB}/object`)).accessControl).toBe('AuthorizationByApplication');
  });

  it('has no accessControl for an entity indexed without one', async () => {
    expect(await entity(`${ROOT}/unindexed`)).not.toHaveProperty('accessControl');
  });

  it('counts a whole page of entities in one query', async () => {
    const query = vi.spyOn(prisma, '$queryRaw');

    await app.inject({ method: 'GET', url: `${config.prefix}/entities?memberOf=${encodeURIComponent(ROOT)}` });

    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();
  });

  it('adds the fields to listed entities too', async () => {
    const { entities } = (await app.inject({ method: 'GET', url: `${config.prefix}/entities?memberOf=${encodeURIComponent(ROOT)}` })).json();

    expect(entities.find(({ id }: { id: string }) => id === SUB)).toMatchObject({
      accessControl: 'AuthorizationByApplication',
      counts: { collections: 0, objects: 1, subCollections: 0, files: 2 },
    });
  });
});
