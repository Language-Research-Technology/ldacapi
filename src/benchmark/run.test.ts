import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discardRepository, prepareRepository, report, runBenchmark } from './run.ts';

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
    ['one-crate', '1 crate'],
    ['split', '4 crates'],
  ] as const)(
    'indexes the %s shape into fresh indexes and measures the indexing process',
    async (shape, crates) => {
      const repository = await prepareRepository(join(workDir, shape), { ...tiny, shape });
      // 1 top + 1 sub-collection; 2 objects, each with 2 files
      expect(repository.entities).toBe(8);

      const result = await runBenchmark(repository);

      expect(result.seconds).toBeGreaterThan(0);
      // Node alone needs tens of MB
      expect(result.peakMemoryBytes).toBeGreaterThan(10 * 1024 * 1024);
      expect(result.rows).toBe(8);
      expect(result.documents).toBe(8);
      expect(await readFile(result.logFile, 'utf-8')).toContain('Job finished');
      expect(report(shape, repository, result)).toMatch(new RegExp(`^${shape}: ${crates}, 8 entities; indexed 8 rows and 8 search documents; .*: met\\)$`));

      await discardRepository(repository);
      await expect(access(repository.root)).rejects.toThrow();
      await expect(access(result.logFile)).resolves.toBeUndefined();
    },
    120_000,
  );

  it('fails when the indexing process does, pointing at its log', async () => {
    const repository = await prepareRepository(join(workDir, 'failing'), { ...tiny, shape: 'split' });

    await expect(runBenchmark(repository, ['-e', 'process.exit(3)'])).rejects.toThrow(`Indexing exited with 3; see ${join(workDir, 'failing', 'index.log')}`);
  }, 120_000);
});
