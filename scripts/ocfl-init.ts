import { config } from '../src/configuration.ts';
import { logger } from '../src/logger.ts';
import { openOrCreateRepository } from '../src/ocfl-repository.ts';

await openOrCreateRepository();
logger.info({ root: config.ocfl.root }, 'The OCFL repository is ready');
