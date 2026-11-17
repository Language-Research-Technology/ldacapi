import { createStorageRoot, OcflError, openStorageRoot, type StorageRoot } from '@ocfl/ocfl-fs';
import type { StorageBackend } from 'arocapi';
import { OcflStorage } from 'arocapi/storage/ocfl';
import { logger } from '../logger.ts';

const log = logger.child({ module: 'repository' });

const isMissing = (error: unknown) => error instanceof OcflError && error.code === 'INVALID_STORAGE_ROOT' && error.ocflCode === 'E069';

/** The OCFL repository at `root`, which must exist */
export async function openRepository(root: string): Promise<StorageRoot> {
  try {
    return await openStorageRoot(root);
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`Cannot load the OCFL repository at ${root}. Run \`pnpm ocfl:init\` to create it.`, { cause: error });
    }
    throw error;
  }
}

/** The OCFL repository at `root`, created empty if it doesn't exist yet */
export async function openOrCreateRepository(root: string): Promise<StorageRoot> {
  try {
    return await openStorageRoot(root);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    return createStorageRoot(root, { layout: { extensionName: '000N-path-direct-storage-layout' } });
  }
}

/** arocapi's content storage backend over the OCFL repository at `root` */
export const contentStorage = async (root: string): Promise<StorageBackend['content']> => (await OcflStorage({ root })).content;

/** The id of each crate in the repository, including one that can't be read whose inventory names it, logging those that can't be read */
export async function* crateIds(repository: StorageRoot) {
  for await (const entry of repository.objects()) {
    if ('object' in entry) {
      yield entry.object.id;
      continue;
    }
    log.error({ err: entry.error, objectRoot: entry.objectRoot, crateId: entry.id }, 'Cannot read crate');
    if (entry.id) {
      yield entry.id;
    }
  }
}
