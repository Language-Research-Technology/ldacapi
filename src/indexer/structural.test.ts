import fs from 'node:fs';
import { ROCrate } from 'ro-crate';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../prisma.ts';
import type { CrateObject } from './indexer.ts';
import { entityAsCrate, StructuralIndexer } from './structural.ts';

describe('entityAsCrate', () => {
  it('preserves the original RO-Crate context when serializing an entity', async () => {
    const raw = JSON.parse(fs.readFileSync('./test-data/distributed_root/ro-crate-metadata.json', 'utf8'));

    const crate = await ROCrate.create(raw);
    const result = entityAsCrate(crate, crate.root, '');
    expect(result['@context']).toEqual(crate['@context']);
  });
});

describe('StructuralIndexer file size', () => {
  const ROOT = 'arcp://name,structural-size-test';
  const LICENSE = 'https://creativecommons.org/licenses/by/4.0/';

  const index = async (files: Record<string, unknown>[], inventory: Record<string, number>) => {
    const crate = await ROCrate.create({
      '@context': 'https://w3id.org/ro/crate/1.1/context',
      '@graph': [
        { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': ROOT }, license: LICENSE },
        { '@id': ROOT, '@type': 'Dataset', name: 'Size test', license: LICENSE, hasPart: files.map((f) => ({ '@id': f['@id'] })) },
        ...files.map((f) => ({ '@type': 'File', ...f })),
      ],
    });
    const crateObject: CrateObject = {
      id: 'size-test',
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
    await (await StructuralIndexer.create({})).index({ crateObject, crate });
  };

  const sizeOf = async (path: string) => Number((await prisma.file.findUniqueOrThrow({ where: { id: `${ROOT}/${path}` } })).size);

  afterEach(async () => {
    await (await StructuralIndexer.create({})).delete(ROOT);
  });

  it('takes the size from the OCFL inventory when the file is there', async () => {
    await index([{ '@id': 'a.txt', contentSize: '14384 bytes' }], { 'a.txt': 500 });

    expect(await sizeOf('a.txt')).toBe(500);
  });

  it('takes the leading number of contentSize when the file is missing', async () => {
    await index(
      [
        { '@id': 'bytes.txt', contentSize: '14384 bytes' },
        { '@id': 'number.txt', contentSize: 163840 },
      ],
      {},
    );

    expect(await sizeOf('bytes.txt')).toBe(14384);
    expect(await sizeOf('number.txt')).toBe(163840);
  });

  it('records -1 when the file is missing and contentSize has no number', async () => {
    await index([{ '@id': 'none.txt' }, { '@id': 'unknown.txt', contentSize: 'unknown' }], {});

    expect(await sizeOf('none.txt')).toBe(-1);
    expect(await sizeOf('unknown.txt')).toBe(-1);
  });
});
