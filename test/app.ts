import { Readable } from 'node:stream';
import { vi } from 'vitest';
import type { Repository } from '../src/repository.ts';

/** A repository with no content */
export const repository = { storage: () => ({ content: {} }), async *objects() {} } as unknown as Repository;

/** A repository whose every file holds `content` */
export const repositoryWithContent = {
  storage: () => ({
    content: () => ({ type: 'stream', open: () => Readable.from(['content']), contentLength: 7, contentType: 'text/plain' }),
  }),
} as unknown as Repository;

/** Builds the app with `env` set while configuration is read, which happens on first import; `'ocfl'` uses the OCFL repository at `OCFL_ROOT` */
export const buildTestApp = async (env: Record<string, string>, options: { repository?: Repository | 'ocfl' } = {}) => {
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
    const repo =
      options.repository === 'ocfl'
        ? await (await import('../src/repository.ts')).initRepository('ocfl', { opensearchClient, search })
        : (options.repository ?? repository);
    /** Builds another app, as another server process would */
    const build = () => buildApp({ repository: repo, search });
    return { app: build(), build, config, prisma, repository: repo };
  } finally {
    vi.unstubAllEnvs();
  }
};

export type TestApp = Awaited<ReturnType<typeof buildTestApp>>['app'];
