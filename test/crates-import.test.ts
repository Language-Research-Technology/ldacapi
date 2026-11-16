import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorageRoot } from '@ocfl/ocfl-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BUNDLED = 'arcp://name,bundled';

describe('crates:import', () => {
  let storage: string;
  let source: string;
  const root = () => join(storage, 'ocfl');
  const importCrates = () =>
    execFileSync('node', ['scripts/crates-import.ts', source], { env: { ...process.env, OCFL_ROOT: root(), LOG_LEVEL: 'silent' }, stdio: 'ignore' });
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
    importCrates();

    expect(await head(BUNDLED)).toMatchObject({ number: 1, message: `Imported from ${join(source, 'bundled')}`, user: { name: 'ldacapi crates:import' } });
  });

  it('adds no version when a crate is imported again unchanged', async () => {
    importCrates();

    importCrates();

    expect((await head(BUNDLED)).number).toBe(1);
  });

  it('merges a changed crate into a new version, keeping files it no longer has', async () => {
    importCrates();
    const before = [...(await head(BUNDLED)).files.keys()];
    await writeFile(join(source, 'bundled', 'notes.txt'), 'added');
    await unlink(join(source, 'bundled', 'facts.csv'));

    importCrates();

    const after = await head(BUNDLED);
    expect(after.number).toBe(2);
    expect([...after.files.keys()].sort()).toEqual([...before, 'notes.txt'].sort());
  });
});
