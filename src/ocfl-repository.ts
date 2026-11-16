import { createStorageRoot, OcflError, openStorageRoot, type StorageRoot } from '@ocfl/ocfl-fs';
import { config } from './configuration.ts';

const isMissing = (error: unknown) => error instanceof OcflError && error.code === 'INVALID_STORAGE_ROOT' && error.ocflCode === 'E069';

/** The OCFL repository, which must exist */
export async function openRepository(): Promise<StorageRoot> {
  try {
    return await openStorageRoot(config.ocfl.root);
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`Cannot load the OCFL repository at ${config.ocfl.root}. Run \`pnpm ocfl:init\` to create it.`, { cause: error });
    }
    throw error;
  }
}

/** The OCFL repository, created empty if it doesn't exist yet */
export async function openOrCreateRepository(): Promise<StorageRoot> {
  try {
    return await openStorageRoot(config.ocfl.root);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    return createStorageRoot(config.ocfl.root, { layout: { extensionName: '000N-path-direct-storage-layout' } });
  }
}
