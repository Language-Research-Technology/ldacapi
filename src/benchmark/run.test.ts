import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { benchmarkShapes, prepareRepository, runBenchmark } from './run.ts';

const tiny = { collections: 1, objectsPerCollection: 2, filesPerObject: 2 };

describe('runBenchmark', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'benchmark-run-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it.each([
    ['one-crate', '1 crate', false],
    ['split', '4 crates', true],
  ] as const)(
    'indexes the %s shape, %s, into fresh indexes, reports on the indexing process, and keeps its repository only if asked (%s)',
    async (shape, crates, keep) => {
      const printed: string[] = [];

      await benchmarkShapes(workDir, [shape], tiny, { keep, print: (line) => printed.push(line) });

      // 1 top + 1 sub-collection; 2 objects, each with 2 files; rows and documents add the author, a shared person
      expect(printed).toEqual([
        `${shape}: generating and importing`,
        `${shape}: indexing`,
        expect.stringMatching(
          new RegExp(
            `^${shape}: ${crates}, 8 entities; indexed 9 rows and 9 search documents; in [\\d.]+ s, peak memory \\d+ MB; .*: met\\); a page of 100 entities read in .* ms slower; \\(target at most 50 ms slower: met\\)$`,
          ),
        ),
      ]);
      expect(await readFile(join(workDir, shape, 'index.log'), 'utf-8')).toContain('Job finished');
      const kept = access(join(workDir, shape, 'ocfl'));
      await (keep ? expect(kept).resolves.toBeUndefined() : expect(kept).rejects.toThrow());
    },
    120_000,
  );

  it('fails when the indexing process does, pointing at its log', async () => {
    const repository = await prepareRepository(join(workDir, 'failing'), { ...tiny, shape: 'split' });

    await expect(runBenchmark(repository, ['-e', 'process.exit(3)'])).rejects.toThrow(`Indexing exited with 3; see ${join(workDir, 'failing', 'index.log')}`);
  }, 120_000);
});
