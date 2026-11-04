import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ocflTestbed } from '../test/app.ts';

const logs = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('./logger.ts', async () => (await import('../test/logs.ts')).capturingLogger(logs, 'warn'));

const FIRST = 'arcp://name,cycle_first';
const SECOND = 'arcp://name,cycle_second';
const LICENSE = { '@id': 'https://creativecommons.org/licenses/by/4.0/' };

const collection = (id: string, parent: string) => ({
  '@context': ['https://w3id.org/ro/crate/1.1/context', 'https://w3id.org/ldac/context', { '@vocab': 'http://schema.org/' }],
  '@graph': [
    { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', license: LICENSE, about: { '@id': id } },
    {
      '@id': id,
      '@type': ['Dataset', 'RepositoryCollection'],
      conformsTo: { '@id': 'https://w3id.org/ldac/profile#Collection' },
      memberOf: { '@id': parent },
      name: id,
      license: LICENSE,
    },
  ],
});

const testbed = ocflTestbed({
  source: async (scratch) => {
    const source = join(scratch, 'crates');
    for (const [name, id, parent] of [
      ['first', FIRST, SECOND],
      ['second', SECOND, FIRST],
    ] as const) {
      await mkdir(join(source, name), { recursive: true });
      await writeFile(join(source, name, 'ro-crate-metadata.json'), JSON.stringify(collection(id, parent)));
    }
    return source;
  },
});

beforeAll(async () => {
  await testbed.started.repository.deleteIndex();
  await testbed.started.repository.createIndex(FIRST);
});

describe('collections that are members of each other', () => {
  it('logs the cycle, naming the crates', () => {
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 40,
        crateId: FIRST,
        cycle: [FIRST, SECOND, FIRST],
        msg: 'Collections are members of each other; using the highest found',
      }),
    );
  });

  it('still indexes the crate under the highest collection found', async () => {
    const row = await testbed.started.prisma.entity.findUnique({ where: { id: FIRST }, select: { rootCollection: true } });

    expect(row?.rootCollection).toBe(SECOND);
  });
});
