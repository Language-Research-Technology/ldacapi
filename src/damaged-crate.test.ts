import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ocflTestbed } from '../test/app.ts';
import { prisma } from './prisma.ts';

const PEOPLE = 'arcp://name,people';
const BUNDLED = 'arcp://name,bundled';

const testbed = ocflTestbed();

describe('a crate whose OCFL object is damaged', () => {
  beforeAll(async () => {
    const { config, repository } = testbed.started;
    await writeFile(join(config.ocfl.root, 'arcp_name_people', '__object__', 'inventory.json'), 'not json');
    await repository.deleteIndex();
    await repository.createIndex();
  });

  it('is left out when every crate is indexed, and the rest are indexed', async () => {
    const ids = (await prisma.entity.findMany({ where: { id: { in: [PEOPLE, BUNDLED] } }, select: { id: true } })).map(({ id }) => id);

    expect(ids).toEqual([BUNDLED]);
  });

  it('is left out of the list of crates', async () => {
    const ids = (await Array.fromAsync(testbed.started.repository.objects())).map(({ id }) => id);

    expect(ids).toContain(BUNDLED);
    expect(ids).not.toContain(PEOPLE);
  });
});
