import { parseArgs } from 'node:util';
import { openIndexing } from '../src/indexer/deps.ts';
import { indexAndSummarise } from '../src/indexer/index-run.ts';

const { values } = parseArgs({ options: { force: { type: 'boolean', default: false } } });

const { deps, indexQueue, close } = await openIndexing();
const { failed } = await indexAndSummarise(deps, indexQueue, () => indexQueue.indexEverything({ reindex: values.force }));
process.exitCode = failed.length > 0 ? 1 : 0;
await close();
