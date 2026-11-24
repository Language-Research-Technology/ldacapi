import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { config } from '../src/configuration.ts';
import { importCrates, importMode } from '../src/crates-import.ts';
import { openIndexing } from '../src/indexer/deps.ts';
import { indexAndSummarise } from '../src/indexer/index-and-summarise.ts';
import { logger } from '../src/logger.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: { index: { type: 'boolean', default: true }, mode: { type: 'string' } },
});
const mode = importMode(values.mode);
if (!mode) {
  logger.error({ mode: values.mode }, 'Give --mode sync (make each crate match its folder) or --mode add (add and replace files, removing none)');
  process.exit(2);
}

const { repository, deps, indexQueue, close } = await openIndexing({ create: true });
const indexing = values.index ? { indexQueue, run: (ask: () => Promise<string[]>) => indexAndSummarise(deps, indexQueue, ask) } : undefined;
process.exitCode = (await importCrates(repository, resolve(positionals[0] ?? 'test-data'), { mode, indexing })) ? 0 : 1;
logger.info({ root: config.ocfl.root }, 'Imported crates into the OCFL repository');
await close();
