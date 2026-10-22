import { Client } from '@opensearch-project/opensearch';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { buildApp } from './app.ts';
import { config } from './configuration.ts';
import { createSearchBackend } from './indexer/search.ts';
import type { Repository } from './repository.ts';

const repository = { storage: () => ({ content: {} }) } as unknown as Repository;
const search = createSearchBackend(new Client({ node: config.opensearchUrl }));

describe('buildApp', () => {
  it('serves the version', async () => {
    const app = buildApp({ repository, search });

    const response = await app.inject({ method: 'GET', url: `${config.prefix}/version` });

    expect(response.json()).toEqual({ version: pkg.version });
    await app.close();
  });
});
