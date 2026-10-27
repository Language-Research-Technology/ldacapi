import type { StorageBackend } from 'arocapi';

export const State = {
  INDEXED: 'indexed',
  INDEXING: 'indexing',
  DELETING: 'deleting',
  QUEUED: 'queued',
} as const;

type IndexState = (typeof State)[keyof typeof State];

/** A crate in the repository, with the state of each index that isn't idle */
export type RepositoryObject = { id: string; path: string; name?: string | undefined; state: Partial<Record<string, IndexState>> };

/**
 * Abstraction for repository operations, such as indexing and listing objects. This is used by the API routes to interact with the underlying data store, which can be an OCFL storage or a database.
 */
export interface Repository {
  init(): Promise<void>;
  getState(crateId: string, type?: string): Promise<Record<string, IndexState>>;
  createIndex(crateId?: string | RegExp, type?: string, force?: boolean): Promise<void>;
  deleteIndex(crateId?: string, type?: string | string[]): Promise<void>;
  objects(prefix?: string, refresh?: boolean): AsyncIterable<RepositoryObject>;
  storage(): StorageBackend;
}

/** Load or initialize a repository */
export async function initRepository(type: string, opts: Record<string, unknown>): Promise<Repository> {
  const repo = await import(`./${type}.ts`);
  await repo.init(opts);
  return repo;
}
