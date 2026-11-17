import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ocflTestbed } from '../../test/app.ts';
import { collection, crate } from '../../test/crate-builder.ts';
import type { SearchBackend } from '../search-backend.ts';

const logs = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('../logger.ts', async () => (await import('../../test/logs.ts')).capturingLogger(logs, 'info'));

const FIRST = 'arcp://name,first';
const SECOND = 'arcp://name,second';
const UNLICENSED = 'arcp://name,unlicensed';
const GONE = 'arcp://name,gone';

const testbed = ocflTestbed(crate(collection(FIRST)), crate(collection(SECOND)), crate(collection(UNLICENSED, { licence: null })));

const indexAndSummarise = async (ask: () => Promise<string[]>, options?: { pollMilliseconds: number }) => {
  const { indexer, indexQueue } = testbed.started;
  // Imported once the testbed has read its configuration
  const { indexAndSummarise } = await import('./index-run.ts');
  return indexAndSummarise(indexer, indexQueue, ask, options);
};

beforeEach(async () => {
  await testbed.started.emptyEverything();
  logs.length = 0;
});

describe('indexing from the command line', () => {
  it('counts the crates it asked for that were indexed, skipped, deleted and failed, and lists each failure', async () => {
    const { indexQueue, prisma } = testbed.started;
    await indexQueue.index(FIRST);
    await testbed.started.workTheQueue();
    await prisma.crateRecord.create({ data: { id: GONE, indexedVersion: 1, indexedAt: new Date() } });

    const summary = await indexAndSummarise(() => indexQueue.indexEverything());

    const failure = { crateId: UNLICENSED, error: 'Error: The crate has no licence, and none is configured as the default', stage: 'deriving', failedOn: null };
    expect(summary).toEqual({ indexed: 1, skipped: 1, deleted: 1, failed: [failure] });
    expect(logs).toContainEqual(expect.objectContaining({ level: 30, indexed: 1, skipped: 1, deleted: 1, failed: 1, msg: 'Indexing finished' }));
    expect(logs).toContainEqual(expect.objectContaining({ level: 50, ...failure, msg: 'Crate failed to index' }));
  });

  it('waits for the jobs it asked for that a worker runs, and counts them', async () => {
    const { indexer, indexQueue } = testbed.started;
    // Imported once the testbed has read its configuration
    const { workTheQueue } = await import('./indexer.ts');
    const { promise: through, resolve: letThrough } = Promise.withResolvers<void>();
    const held: SearchBackend = {
      ...indexer.search,
      index: async (documents) => {
        await through;
        await indexer.search.index(documents);
      },
    };
    const stop = new AbortController();
    const worker = workTheQueue({ ...indexer, search: held }, { until: 'aborted', signal: stop.signal });
    let finished = false;

    const running = indexAndSummarise(
      async () => {
        await indexQueue.index(FIRST);
        await vi.waitFor(async () => expect(await indexQueue.crate(FIRST)).toMatchObject({ state: 'indexing' }), { timeout: 5000 });
        await indexQueue.index(SECOND);
        return [FIRST, SECOND];
      },
      { pollMilliseconds: 20 },
    ).then((summary) => {
      finished = true;
      return summary;
    });

    await vi.waitFor(async () => expect(await indexQueue.crate(SECOND)).toMatchObject({ state: 'indexed' }), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(finished).toBe(false);

    letThrough();
    expect(await running).toEqual({ indexed: 2, skipped: 0, deleted: 0, failed: [] });
    stop.abort();
    await worker;
  }, 20_000);
});
