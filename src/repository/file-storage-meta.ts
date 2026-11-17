import type { OcflStorageMeta } from 'arocapi';

/** Where arocapi's content storage finds a file: at `ocflPath` in the OCFL object `ocflObject`, or nowhere for a file not held */
export const fileStorageMeta = (ocflObject: string, ocflPath: string | undefined): OcflStorageMeta | Record<string, never> =>
  ocflPath === undefined ? {} : { ocflObject, ocflPath };
