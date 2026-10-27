import { Client } from '@opensearch-project/opensearch';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { repository } from '../test/app.ts';
import { buildApp } from './app.ts';
import { config } from './configuration.ts';
import { createSearchBackend } from './indexer/search.ts';

const search = createSearchBackend(new Client({ node: config.opensearchUrl }));

describe('buildApp', () => {
  it('serves the version', async () => {
    const app = buildApp({ repository, search });

    const response = await app.inject({ method: 'GET', url: `${config.prefix}/version` });

    expect(response.json()).toEqual({ version: pkg.version });
    await app.close();
  });

  it('allows any origin to call the API, without credentials', async () => {
    const app = buildApp({ repository, search });
    const origin = 'https://elsewhere.example.org';

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: `${config.prefix}/search`,
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers).toMatchObject({
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, POST',
      'access-control-max-age': '7200',
    });
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();

    const response = await app.inject({ method: 'GET', url: `${config.prefix}/version`, headers: { origin } });
    expect(response.headers['access-control-allow-origin']).toBe('*');
    await app.close();
  });

  it('sends no CORS headers outside the API', async () => {
    const app = buildApp({ repository, search });
    const headers = { origin: 'https://elsewhere.example.org', 'access-control-request-method': 'POST' };

    for (const url of ['/admin/', '/oauth/token']) {
      const response = await app.inject({ method: 'OPTIONS', url, headers });
      expect(response.headers['access-control-allow-origin'], url).toBeUndefined();
    }
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
