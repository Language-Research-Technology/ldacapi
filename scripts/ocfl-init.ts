import { config } from '../src/configuration.ts';
import { logger } from '../src/logger.ts';
import { openOrCreateRepository } from '../src/repository/repository.ts';

await openOrCreateRepository(config.ocfl.root);
logger.info({ root: config.ocfl.root }, 'The OCFL repository is ready');
