import { openIndexing } from './indexer/deps.ts';
import { workTheQueue } from './indexer/indexer.ts';
import { logger } from './logger.ts';

const { deps, close } = await openIndexing();
const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'Stopping, releasing the current job');
    stop.abort();
  });
}

logger.info('Worker started');
await workTheQueue(deps, { until: 'aborted', signal: stop.signal });
await close();
