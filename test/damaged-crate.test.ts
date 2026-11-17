import { readFile, writeFile } from 'node:fs/promises';
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
    const { config, emptyEverything, indexQueue, workTheQueue } = testbed.started;
    expect(config.ocfl.root.startsWith(tmpdir())).toBe(true);
    // Still names its id, but has no versions
    const inventory = join(config.ocfl.root, 'arcp_name_people', '__object__', 'inventory.json');
    const { versions: _, ...damaged } = JSON.parse(await readFile(inventory, 'utf8'));
    await writeFile(inventory, JSON.stringify(damaged));
    await emptyEverything();
    await indexQueue.indexEverything();
    await workTheQueue();
  });

  it('fails while the others index', async () => {
    expect(await testbed.state(PEOPLE)).toMatchObject({ state: 'failed', stage: 'reading the crate', error: expect.stringContaining('OcflError') });
    expect(await testbed.state(BUNDLED)).toMatchObject({ state: 'indexed' });
  });

  it('is left out of search, and the rest are searchable', async () => {
    const ids = (await testbed.started.prisma.entity.findMany({ where: { id: { in: [PEOPLE, BUNDLED] } }, select: { id: true } })).map(({ id }) => id);

    expect(ids).toEqual([BUNDLED]);
  });
});
