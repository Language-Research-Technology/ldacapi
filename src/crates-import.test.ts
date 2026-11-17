import { cp, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorageRoot } from '@ocfl/ocfl-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importCrates as importInto } from './crates-import.ts';
import { openOrCreateRepository } from './repository/repository.ts';

const BUNDLED = 'arcp://name,bundled';

describe('crates:import', () => {
  let storage: string;
  let source: string;
  const root = () => join(storage, 'ocfl');
  const importCrates = async () => importInto(await openOrCreateRepository(root()), source);
  const head = async (id: string) => (await (await openStorageRoot(root())).open(id)).head;

  beforeEach(async () => {
    storage = await mkdtemp(join(tmpdir(), 'ldacapi-'));
    source = join(storage, 'crates');
    await cp('test-data', source, { recursive: true });
  });

  afterEach(async () => {
    await rm(storage, { recursive: true, force: true });
  });

  it('records who imported each crate, and from where', async () => {
    await importCrates();

    expect(await head(BUNDLED)).toMatchObject({
      number: 1,
      message: `Imported from ${join(source, 'bundled')}`,
      user: { name: 'ldacapi crates:import', address: 'https://github.com/Language-Research-Technology/ldacapi' },
    });
  });

  it('adds no version when a crate is imported again unchanged', async () => {
    await importCrates();

    await importCrates();

    expect((await head(BUNDLED)).number).toBe(1);
  });

  it('merges a changed crate into a new version, keeping files it no longer has', async () => {
    await importCrates();
    const before = [...(await head(BUNDLED)).files.keys()];
    await writeFile(join(source, 'bundled', 'notes.txt'), 'added');
    await unlink(join(source, 'bundled', 'facts.csv'));

    await importCrates();

    const after = await head(BUNDLED);
    expect(after.number).toBe(2);
    expect([...after.files.keys()].sort()).toEqual([...before, 'notes.txt'].sort());
  });
});
