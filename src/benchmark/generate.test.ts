import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateCollection, generateShapes } from './generate.ts';

type Graph = { '@graph': { '@id': string; '@type': string | string[] }[] };

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'benchmark-test-'));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const crateDirs = async (dir: string) => (await readdir(dir)).sort();

const graphOf = async (crateDir: string): Promise<Graph> => JSON.parse(await readFile(join(crateDir, 'ro-crate-metadata.json'), 'utf-8'));

/** How many entities of each record type the crates under `dir` describe */
async function countTypes(dir: string) {
  const counts: Record<string, number> = { RepositoryCollection: 0, RepositoryObject: 0, File: 0 };
  for (const name of await crateDirs(dir)) {
    for (const entity of (await graphOf(join(dir, name)))['@graph']) {
      for (const type of [entity['@type']].flat()) {
        if (type in counts) {
          counts[type] = (counts[type] ?? 0) + 1;
        }
      }
    }
  }
  return counts;
}

/** Each file under `dir` by relative path, with a hash of its bytes */
async function hashes(dir: string) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file.slice(dir.length),
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  );
}

async function textFileSizes(dir: string) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const texts = entries.filter((e) => e.isFile() && e.name.endsWith('.txt'));
  return Promise.all(texts.map(async (e) => (await stat(join(e.parentPath, e.name))).size));
}

const small = { collections: 2, objectsPerCollection: 3, filesPerObject: 3 };

describe('generateCollection', () => {
  it('puts the whole collection in one crate', async () => {
    const dir = await tempDir();

    const summary = await generateCollection(dir, { ...small, shape: 'one-crate' });

    expect(await crateDirs(dir)).toHaveLength(1);
    // 1 top + 2 sub-collections; 6 objects, each with 3 files
    expect(await countTypes(dir)).toEqual({ RepositoryCollection: 3, RepositoryObject: 6, File: 18 });
    expect(summary).toEqual({ crates: 1, entities: 27 });
  });

  it('splits the collection into a top collection, sub-collection crates and object crates', async () => {
    const dir = await tempDir();

    const summary = await generateCollection(dir, { ...small, shape: 'split' });

    expect(await crateDirs(dir)).toHaveLength(9);
    expect(await countTypes(dir)).toEqual({ RepositoryCollection: 3, RepositoryObject: 6, File: 18 });
    expect(summary).toEqual({ crates: 9, entities: 27 });
  });

  it.each(['one-crate', 'split'] as const)('links each %s member to its parent by pcdm:memberOf', async (shape) => {
    const dir = await tempDir();
    await generateCollection(dir, { ...small, shape });

    const entities = (await Promise.all((await crateDirs(dir)).map(async (name) => (await graphOf(join(dir, name)))['@graph']))).flat();
    const parentOf = (id: string) => (entities.find((e) => e['@id'] === id) as { 'pcdm:memberOf'?: { '@id': string } })?.['pcdm:memberOf']?.['@id'];

    expect(parentOf('arcp://name,benchmark')).toBeUndefined();
    expect(parentOf('arcp://name,benchmark/collection-2')).toBe('arcp://name,benchmark');
    expect(parentOf('arcp://name,benchmark/collection-2/object-3')).toBe('arcp://name,benchmark/collection-2');
  });

  it('includes text files of 50 KB, 1 MB and 5 MB', async () => {
    const dir = await tempDir();

    await generateCollection(dir, { ...small, shape: 'split' });

    expect(new Set(await textFileSizes(dir))).toEqual(new Set([50 * 1024, 1024 * 1024, 5 * 1024 * 1024]));
  });

  it.each(['one-crate', 'split'] as const)('writes byte-identical %s crates for the same options', async (shape) => {
    const [first, second] = [await tempDir(), await tempDir()];

    await generateCollection(first, { ...small, shape });
    await generateCollection(second, { ...small, shape });

    expect(await hashes(second)).toEqual(await hashes(first));
  });

  it('writes different text for a different seed', async () => {
    const [first, second] = [await tempDir(), await tempDir()];

    await generateCollection(first, { ...small, shape: 'split', seed: 1 });
    await generateCollection(second, { ...small, shape: 'split', seed: 2 });

    expect(await hashes(second)).not.toEqual(await hashes(first));
  });
});

describe('generateShapes', () => {
  it('writes each shape under its own directory, printing what it holds', async () => {
    const dir = await tempDir();
    const printed: string[] = [];

    await generateShapes(dir, ['one-crate', 'split'], small, (line) => printed.push(line));

    expect(await crateDirs(dir)).toEqual(['one-crate', 'split']);
    expect(printed).toEqual([`one-crate: 1 crates, 27 entities in ${join(dir, 'one-crate')}`, `split: 9 crates, 27 entities in ${join(dir, 'split')}`]);
  });
});
