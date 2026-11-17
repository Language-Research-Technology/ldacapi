import type { IndexQueue, Summary } from '../index-queue/index-queue.ts';
import { logger } from '../logger.ts';
import { type IndexerDeps, workTheQueue } from './indexer.ts';

const log = logger.child({ module: 'indexer' });

/**
 * Asks for jobs with `ask`, which returns the ids of the crates asked for, then works the queue until every one of them
 * is finished, here or by a worker. Logs and returns what became of those crates
 */
export async function indexAndSummarise(deps: IndexerDeps, indexQueue: IndexQueue, ask: () => Promise<string[]>): Promise<Summary> {
  const run = await indexQueue.startRun();
  const crateIds = await ask();
  await workTheQueue(deps, { until: 'finished', crateIds });
  const summary = await run.summary(crateIds);
  const { failed, ...counts } = summary;
  log.info({ ...counts, failed: failed.length }, 'Indexing finished');
  for (const failure of failed) {
    log.error(failure, 'Crate failed to index');
  }
  return summary;
}
