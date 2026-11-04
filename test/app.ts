import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Client } from '@opensearch-project/opensearch';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import type { createSearchBackend } from '../src/indexer/search.ts';
import { initRepository, type Repository } from '../src/repository.ts';

type RepositoryDeps = { opensearchClient: Client; search: ReturnType<typeof createSearchBackend> };

/** A repository, or how to build one with the app's search */
export type TestRepository = Repository | ((deps: RepositoryDeps) => Repository | Promise<Repository>);

/** A repository with no content */
export const repository = { storage: () => ({ content: {} }), async *objects() {} } as unknown as Repository;

/** A repository whose every file holds `content`, served as the file's media type */
export const repositoryWithContent = {
  storage: () => ({
    content: (file: { mediaType?: string }) => ({
      type: 'stream',
      open: () => Readable.from(['content']),
      contentLength: 7,
      contentType: file.mediaType ?? 'text/plain',
    }),
  }),
} as unknown as Repository;

/** The OCFL repository at `OCFL_ROOT` */
export const ocflRepository = (deps: Record<string, unknown>) => initRepository('ocfl', deps);

/** Builds the app with `env` set while configuration is read, which happens on first import */
export const buildTestApp = async (env: Record<string, string>, options: { repository?: TestRepository } = {}) => {
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  try {
    const { config } = await import('../src/configuration.ts');
    const { prisma } = await import('../src/prisma.ts');
    const { buildApp } = await import('../src/app.ts');
    const { Client } = await import('@opensearch-project/opensearch');
    const { createSearchBackend } = await import('../src/indexer/search.ts');
    const opensearchClient = new Client({ node: config.opensearchUrl });
    const search = createSearchBackend(opensearchClient);
    const repo = typeof options.repository === 'function' ? await options.repository({ opensearchClient, search }) : (options.repository ?? repository);
    /** Builds another app, as another server process would */
    const build = () => buildApp({ repository: repo, search });
    return { app: build(), build, config, prisma, repository: repo, search };
  } finally {
    vi.unstubAllEnvs();
  }
};

export type TestApp = Awaited<ReturnType<typeof buildTestApp>>['app'];

/**
 * A new OCFL repository for a file's tests, imported from the directory `source` returns (test-data by default),
 * which it may create under the scratch directory it is given
 */
export const ocflStorage = ({ source }: { source?: (scratch: string) => Promise<string> } = {}) => {
  let storage: string;
  const ocflRoot = () => join(storage, 'ocfl');

  beforeAll(async () => {
    storage = await mkdtemp(join(tmpdir(), 'ldacapi-'));
    const sources = source ? [await source(storage)] : [];
    execFileSync('node', ['scripts/crates-import.ts', ...sources], { env: { ...process.env, OCFL_ROOT: ocflRoot(), LOG_LEVEL: 'silent' }, stdio: 'ignore' });
  });

  afterAll(async () => {
    await rm(storage, { recursive: true, force: true });
  });

  return { ocflRoot };
};

/** The app over a new OCFL repository (see `ocflStorage`), its indexes deleted after the file's tests */
export const ocflTestbed = (options: Parameters<typeof ocflStorage>[0] = {}) => {
  const { ocflRoot } = ocflStorage(options);
  let started: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    started = await buildTestApp({ OCFL_ROOT: ocflRoot(), LOG_LEVEL: 'silent' }, { repository: ocflRepository });
  });

  afterAll(async () => {
    await started?.repository.deleteIndex();
    await started?.app.close();
    await started?.prisma.$disconnect();
  });

  return {
    get started() {
      return started;
    },

    /** POSTs `body` to the search endpoint, expecting success */
    async search(body: Record<string, unknown>) {
      const response = await started.app.inject({ method: 'POST', url: `${started.config.prefix}/search`, payload: body });
      expect(response.statusCode).toBe(200);
      return response.json();
    },
  };
};
