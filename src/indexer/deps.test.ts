import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ocflStorage } from '../../test/app.ts';
import { collection, crate } from '../../test/crate-builder.ts';

const CRATE = 'arcp://name,opened';

const { ocflRoot } = ocflStorage({ crates: [crate(collection(CRATE))] });

/** `openIndexing`, with the repository configured at `root` */
const openIndexingAt = async (root: string) => {
  vi.resetModules();
  vi.stubEnv('OCFL_ROOT', root);
  vi.stubEnv('LOG_LEVEL', 'silent');
  try {
    return (await import('./deps.ts')).openIndexing;
  } finally {
    vi.unstubAllEnvs();
  }
};

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('opens the configured repository, with search and the index queue, until closed', async () => {
  const openIndexing = await openIndexingAt(ocflRoot());

  const { repository, deps, indexQueue, close } = await openIndexing();

  expect(await repository.has(CRATE)).toBe(true);
  expect(deps.repository).toBe(repository);
  expect(await indexQueue.crates()).toEqual([]);
  await close();
});

it('creates the configured repository, empty, when asked to', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ldacapi-'));
  scratch.push(dir);
  const openIndexing = await openIndexingAt(join(dir, 'ocfl'));

  const { repository, close } = await openIndexing({ create: true });

  expect(await repository.has(CRATE)).toBe(false);
  await close();
});
