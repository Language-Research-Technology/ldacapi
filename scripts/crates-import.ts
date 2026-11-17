import { resolve } from 'node:path';
import { config } from '../src/configuration.ts';
import { importCrates } from '../src/crates-import.ts';
import { logger } from '../src/logger.ts';
import { openOrCreateRepository } from '../src/repository/repository.ts';

if (!(await importCrates(await openOrCreateRepository(config.ocfl.root), resolve(process.argv[2] ?? 'test-data')))) {
  process.exitCode = 1;
}
logger.info({ root: config.ocfl.root }, 'Imported crates into the OCFL repository');
