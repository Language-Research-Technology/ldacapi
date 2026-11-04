import type { StorageBackend } from 'arocapi';

export const State = {
  INDEXED: 'indexed',
  INDEXING: 'indexing',
  DELETING: 'deleting',
  QUEUED: 'queued',
} as const;

export type IndexState = (typeof State)[keyof typeof State];

export const INDEX_TYPES = ['database', 'search'] as const;

export type IndexType = (typeof INDEX_TYPES)[number];

/** Each index's state, absent or undefined while it is idle */
export type IndexStates = Partial<Record<IndexType, IndexState | undefined>>;

/** Whether any index is in one of `values` */
export const hasState = (state: IndexStates, ...values: IndexState[]) => Object.values(state).some((value) => value !== undefined && values.includes(value));

/** A crate in the repository, with the state of each index that isn't idle */
export type RepositoryObject = { id: string; path: string; name?: string | undefined; state: IndexStates };

/**
 * Abstraction for repository operations, such as indexing and listing objects. This is used by the API routes to interact with the underlying data store, which can be an OCFL storage or a database.
 */
export interface Repository {
  init(): Promise<void>;
  getState(crateId: string, type?: IndexType): Promise<IndexStates>;
  createIndex(crateIds?: string | string[] | RegExp, type?: IndexType | IndexType[], force?: boolean): Promise<void>;
  deleteIndex(crateId?: string, type?: IndexType | IndexType[]): Promise<void>;
  objects(prefix?: string, refresh?: boolean): AsyncIterable<RepositoryObject>;
  storage(): StorageBackend;
}

/** Load or initialize a repository */
export async function initRepository(type: string, opts: Record<string, unknown>): Promise<Repository> {
  const repo = await import(`./${type}.ts`);
  await repo.init(opts);
  return repo;
}
