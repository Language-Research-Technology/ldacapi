import { config } from '../src/configuration.ts';
import { logger } from '../src/logger.ts';
import { openOrCreateStorage } from '../src/ocfl.ts';

await openOrCreateStorage();
logger.info({ root: config.ocfl.root }, 'The OCFL repository is ready');
