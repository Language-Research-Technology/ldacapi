import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openOrCreateRepository, openRepository } from './repository.ts';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'repository-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A repository whose version declaration is corrupt */
const corrupt = async (name: string) => {
  const root = join(dir, name);
  await mkdir(root);
  await writeFile(join(root, '0=ocfl_1.1'), 'corrupt');
  return root;
};

describe('openRepository', () => {
  it('says how to create a repository that does not exist', async () => {
    const root = join(dir, 'missing');

    await expect(openRepository(root)).rejects.toThrow(`Cannot load the OCFL repository at ${root}. Run \`pnpm ocfl:init\` to create it.`);
  });

  it('passes on any other failure', async () => {
    await expect(openRepository(await corrupt('corrupt-open'))).rejects.toThrow(/^E080/);
  });
});

describe('openOrCreateRepository', () => {
  it('creates a repository that does not exist, which then opens', async () => {
    const root = join(dir, 'created');

    await openOrCreateRepository(root);

    await expect(openRepository(root)).resolves.toBeDefined();
  });

  it('passes on any other failure', async () => {
    await expect(openOrCreateRepository(await corrupt('corrupt-create'))).rejects.toThrow(/^E080/);
  });
});
