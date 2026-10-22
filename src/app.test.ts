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

  it('has no OIDC provider without an upstream provider', async () => {
    const app = buildApp({ repository, search });

    for (const url of ['/.well-known/openid-configuration', '/oauth/jwks', '/oauth/authorize?client_id=oni']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
    expect((await app.inject({ method: 'POST', url: '/oauth/token' })).statusCode).toBe(404);
    await app.close();
  });

  it('has no relay under the API prefix', async () => {
    const app = buildApp({ repository, search });

    for (const url of ['/.well-known/openid-configuration', '/authorize', '/jwks']) {
      expect((await app.inject({ method: 'GET', url: `${config.prefix}${url}` })).statusCode, url).toBe(404);
    }
    expect((await app.inject({ method: 'POST', url: `${config.prefix}/token` })).statusCode).toBe(404);
    await app.close();
  });
});
