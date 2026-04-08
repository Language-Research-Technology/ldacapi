export interface RepositoryFile {
  /** The file path relative to the repository root */
  path: string;
  stream: () => Promise<ReadableStream>
}

/**
 * Abstraction for repository operations, such as indexing and listing objects. This is used by the API routes to interact with the underlying data store, which can be an OCFL storage or a database. 
 */
export interface Repository {
  init(): Promise<void>;
  getIndexerState(crateId?: string, type?: string): Promise<{ isIndexed: boolean, isIndexing: boolean, isDeleting: boolean }>;
  createIndex(crateId?: string | RegExp, type?: string, force?: boolean): Promise<void>;
  deleteIndex(crateId?: string, type?: string | string[]): Promise<void>;
  objects(): AsyncIterable<{ id: string, path: string, name: string }>;
  getFile(entityId: string, storagePath?: string): Promise<RepositoryFile>
}

/** Load or initialize a repository */
export async function initRepository(type: string, opts: any) : Promise<Repository> {
  const repo = await import(`./${type}.ts`);
  await repo.init(opts);
  return repo;
}

