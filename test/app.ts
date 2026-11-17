import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { StorageRoot } from '@ocfl/ocfl-fs';
import type { StorageBackend } from 'arocapi';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import type { IndexQueue } from '../src/index-queue/index-queue.ts';
import { type Crate, writeCrates } from './crate-builder.ts';

type Storage = StorageBackend['content'];

/** Content storage holding nothing */
const noContent: Storage = async () => null;

/** Content storage whose every file holds `content`, served as the file's media type */
export const contentEverywhere: Storage = async (file) => ({
  type: 'stream',
  open: () => Readable.from(['content']),
  contentLength: 7,
  contentType: file.mediaType ?? 'text/plain',
});

/** What `buildApp` needs besides search, for an app that serves no content and is never asked to index */
export const noRepository = { storage: noContent, indexQueue: {} as IndexQueue };

/** A repository with no crates */
const emptyRepository = { async *objects() {} } as unknown as StorageRoot;

/**
 * Builds the app with `env` set while configuration is read, which happens on first import.
 * With `ocfl`, it serves and indexes the OCFL repository at `OCFL_ROOT`
 */
export const buildTestApp = async (env: Record<string, string>, options: { storage?: Storage; ocfl?: boolean } = {}) => {
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  try {
    const { config } = await import('../src/configuration.ts');
    const { prisma } = await import('../src/prisma.ts');
    const { buildApp } = await import('../src/app.ts');
    const { Client } = await import('@opensearch-project/opensearch');
    const { createSearchBackend, refreshSearchIndex } = await import('../src/search-backend.ts');
    const { createIndexQueue } = await import('../src/index-queue/index-queue.ts');
    const { contentStorage, openRepository } = await import('../src/repository/repository.ts');
    const { workTheQueue } = await import('../src/indexer/indexer.ts');
    const opensearch = new Client({ node: config.opensearchUrl });
    const search = createSearchBackend(opensearch);
    const repository = options.ocfl ? await openRepository(config.ocfl.root) : emptyRepository;
    const storage = options.storage ?? (options.ocfl ? await contentStorage(config.ocfl.root) : noContent);
    const indexQueue = createIndexQueue({ prisma, repository });
    const indexer = { prisma, repository, opensearch, search, licences: config };
    /** Builds another app, as another server process would */
    const build = () => buildApp({ search, storage, indexQueue });
    return {
      app: build(),
      build,
      config,
      prisma,
      opensearch,
      search,
      repository,
      indexQueue,
      indexer,

      /** Works the queue until it is empty, as `pnpm index` does, then makes what it indexed searchable */
      async workTheQueue() {
        await workTheQueue(indexer, { until: 'empty' });
        await refreshSearchIndex(opensearch);
      },

      /** Deletes every index job, crate record, worker, aggregate, row and search document */
      async emptyEverything() {
        await prisma.$executeRaw`TRUNCATE index_job, crate_link, crate, index_worker, aggregate, file, entity CASCADE`;
        await opensearch.indices.delete({ index: config.search.entityIndex, ignore_unavailable: true });
      },
    };
  } finally {
    vi.unstubAllEnvs();
  }
};

export type TestApp = Awaited<ReturnType<typeof buildTestApp>>['app'];

/**
 * A new OCFL repository for a file's tests, holding `crates`, or else imported from the directory `source` returns
 * (test-data by default), which it may create under the scratch directory it is given
 */
export const ocflStorage = ({ crates, source }: { crates?: Crate[]; source?: (scratch: string) => Promise<string> } = {}) => {
  let storage: string;
  const ocflRoot = () => join(storage, 'ocfl');

  beforeAll(async () => {
    storage = await mkdtemp(join(tmpdir(), 'ldacapi-'));
    const sources = crates ? [join(storage, 'crates')] : source ? [await source(storage)] : [];
    if (crates) {
      await writeCrates(join(storage, 'crates'), crates);
    }
    execFileSync('node', ['scripts/crates-import.ts', '--no-index', ...sources], {
      env: { ...process.env, OCFL_ROOT: ocflRoot(), LOG_LEVEL: 'silent' },
      stdio: 'ignore',
    });
  });

  afterAll(async () => {
    await rm(storage, { recursive: true, force: true });
  });

  return { ocflRoot };
};

/** The app over a new OCFL repository (see `ocflStorage`), everything emptied after the file's tests */
export const ocflTestbed = (...crates: Crate[]) => {
  const { ocflRoot } = ocflStorage({ crates });
  let started: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    started = await buildTestApp({ OCFL_ROOT: ocflRoot(), LOG_LEVEL: 'silent' }, { ocfl: true });
  });

  afterAll(async () => {
    await started?.emptyEverything();
    await started?.app.close();
    await started?.prisma.$disconnect();
  });

  return {
    get started() {
      return started;
    },

    /** Empties everything, then indexes `crateIds` in that order */
    async indexOnly(...crateIds: string[]) {
      await started.emptyEverything();
      for (const crateId of crateIds) {
        await started.indexQueue.index(crateId);
      }
      await started.workTheQueue();
    },

    /** POSTs `body` to the search endpoint, expecting success */
    async search(body: Record<string, unknown>) {
      const response = await started.app.inject({ method: 'POST', url: `${started.config.prefix}/search`, payload: body });
      expect(response.statusCode).toBe(200);
      return response.json();
    },
  };
};
