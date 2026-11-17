import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ocflTestbed } from './app.ts';
import { collection, crate } from './crate-builder.ts';

const PEOPLE = 'arcp://name,people';
const BUNDLED = 'arcp://name,bundled';

const testbed = ocflTestbed(crate(collection(PEOPLE)), crate(collection(BUNDLED)));

describe('a crate whose OCFL object is damaged', () => {
  beforeAll(async () => {
    const { config, repository } = testbed.started;
    expect(config.ocfl.root.startsWith(tmpdir())).toBe(true);
    await writeFile(join(config.ocfl.root, 'arcp_name_people', '__object__', 'inventory.json'), 'not json');
    await repository.deleteIndex();
    await repository.createIndex();
  });

  it('is left out when every crate is indexed, and the rest are indexed', async () => {
    const ids = (await testbed.started.prisma.entity.findMany({ where: { id: { in: [PEOPLE, BUNDLED] } }, select: { id: true } })).map(({ id }) => id);

    expect(ids).toEqual([BUNDLED]);
  });

  it('is left out of the list of crates', async () => {
    const ids = (await Array.fromAsync(testbed.started.repository.objects())).map(({ id }) => id);

    expect(ids).toContain(BUNDLED);
    expect(ids).not.toContain(PEOPLE);
  });
});
