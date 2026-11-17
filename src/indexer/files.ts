import type { OcflFile, OcflObject } from '@ocfl/ocfl-fs';
import { logger } from '../logger.ts';

const log = logger.child({ module: 'indexer/files' });

/** The files a crate holds, read by their path in the crate; a file that can't be read is logged and has neither size nor text */
export type CrateFiles = {
  /** The id of the OCFL object holding the crate */
  id: string;
  size(path: string): Promise<number | undefined>;
  text(path: string): Promise<string | undefined>;
};

export function crateFiles(object: OcflObject): CrateFiles {
  const read = async <T>(path: string, reader: (file: OcflFile) => Promise<T>) => {
    try {
      const file = object.head.files.get(path);
      if (!file) {
        throw new Error(`File not found in ocfl inventory: ${path}`);
      }
      return await reader(file);
    } catch (error) {
      log.error({ err: error, crateId: object.id, path }, 'Cannot read file');
    }
  };
  return {
    id: object.id,
    size: (path) => read(path, (file) => file.size()),
    text: (path) => read(path, (file) => file.text()),
  };
}
