import fs from 'node:fs';
import { ROCrate } from 'ro-crate';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { accessControlOf } from '../entity-meta.ts';
import { prisma } from '../prisma.ts';
import { DatabaseIndexer, entityAsCrate } from './database.ts';
import type { CrateObject } from './indexer.ts';

describe('entityAsCrate', () => {
  it('preserves the original RO-Crate context when serializing an entity', async () => {
    const raw = JSON.parse(fs.readFileSync('./test-data/distributed_root/ro-crate-metadata.json', 'utf8'));

    const crate = await ROCrate.create(raw);
    const result = entityAsCrate(crate, crate.root, '');
    expect(result['@context']).toEqual(crate['@context']);
  });
});

describe('DatabaseIndexer', () => {
  const ROOT = 'arcp://name,database-test';
  const OPEN = 'https://creativecommons.org/licenses/by/4.0/';
  const RESTRICTED = 'https://www.ldaca.edu.au/licenses/restricted/v1/';

  let indexer: DatabaseIndexer;

  beforeAll(async () => {
    indexer = await DatabaseIndexer.create({});
  });

  afterEach(async () => {
    await indexer.delete(ROOT);
  });

  const index = async (files: Record<string, unknown>[], inventory: Record<string, number> = {}) => {
    const crate = await ROCrate.create({
      '@context': 'https://w3id.org/ro/crate/1.1/context',
      '@graph': [
        { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': ROOT }, license: OPEN },
        {
          '@id': ROOT,
          '@type': ['Dataset', 'RepositoryCollection'],
          conformsTo: { '@id': 'https://w3id.org/ldac/profile#Collection' },
          name: 'Database test',
          license: OPEN,
          hasPart: files.map((f) => ({ '@id': f['@id'] })),
        },
        ...files.map((f) => ({ '@type': 'File', ...f })),
      ],
    });
    const crateObject: CrateObject = {
      id: 'database-test',
      root: '/nowhere',
      text: async () => '',
      file: async (path) => {
        const size = inventory[path];
        if (size === undefined) {
          throw new Error(`Not in inventory: ${path}`);
        }
        return { size, crc32: '' };
      },
    };
    await indexer.index({ crateObject, crate, topCollection: ROOT });
  };

  describe('file size', () => {
    const sizeOf = async (path: string) => Number((await prisma.file.findUniqueOrThrow({ where: { id: `${ROOT}/${path}` } })).size);

    it('takes the size from the OCFL inventory when the file is there', async () => {
      await index([{ '@id': 'a.txt', contentSize: '14384 bytes' }], { 'a.txt': 500 });

      expect(await sizeOf('a.txt')).toBe(500);
    });

    it('takes the leading number of contentSize when the file is missing', async () => {
      await index([
        { '@id': 'bytes.txt', contentSize: '14384 bytes' },
        { '@id': 'number.txt', contentSize: 163840 },
      ]);

      expect(await sizeOf('bytes.txt')).toBe(14384);
      expect(await sizeOf('number.txt')).toBe(163840);
    });

    it('records -1 when the file is missing and contentSize has no number', async () => {
      await index([{ '@id': 'none.txt' }, { '@id': 'unknown.txt', contentSize: 'unknown' }]);

      expect(await sizeOf('none.txt')).toBe(-1);
      expect(await sizeOf('unknown.txt')).toBe(-1);
    });
  });

  describe('accessControl', () => {
    const storedAccessControl = async (id: string) => accessControlOf((await prisma.entity.findUniqueOrThrow({ where: { id } })).meta);

    it('is Public for an open content licence and AuthorizationByApplication otherwise', async () => {
      await index([{ '@id': 'restricted.txt', license: RESTRICTED }]);

      expect(await storedAccessControl(ROOT)).toBe('Public');
      expect(await storedAccessControl(`${ROOT}/restricted.txt`)).toBe('AuthorizationByApplication');
    });
  });
});
