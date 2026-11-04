import { Client } from '@opensearch-project/opensearch';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { buildTestApp, repository, repositoryWithContent } from '../test/app.ts';
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

  it('has no admin API', async () => {
    const app = buildApp({ repository, search });
    const headers = { authorization: 'Bearer 1234-1234-1234-1234' };

    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      expect((await app.inject({ method, url: `${config.prefix}/admin/index/`, headers })).statusCode, method).toBe(404);
    }
    await app.close();
  });
});

describe('crate file delivery', () => {
  const OPEN = 'https://creativecommons.org/licenses/by/4.0/';
  const files = { 'http://test/delivery/page.html': 'text/html', 'http://test/delivery/song.mp3': 'audio/mpeg' };

  it('sandboxes crate files but not audio or video, so media plays when opened directly', async () => {
    const { app, prisma, config } = await buildTestApp({}, { repository: repositoryWithContent });
    for (const [id, mediaType] of Object.entries(files)) {
      await prisma.entity.create({
        data: { id, name: id, description: '', entityType: 'http://schema.org/MediaObject', metadataLicenseId: OPEN, contentLicenseId: OPEN },
      });
      await prisma.file.create({ data: { id, filename: id.split('/').at(-1) ?? id, mediaType, size: 7 } });
    }

    try {
      const deliver = (id: string) => app.inject({ method: 'GET', url: `${config.prefix}/file/${encodeURIComponent(id)}` });

      const html = await deliver('http://test/delivery/page.html');
      expect(html.statusCode).toBe(200);
      expect(html.headers['x-content-type-options']).toBe('nosniff');
      expect(html.headers['content-security-policy']).toContain('sandbox');

      const audio = await deliver('http://test/delivery/song.mp3');
      expect(audio.statusCode).toBe(200);
      expect(audio.headers['x-content-type-options']).toBe('nosniff');
      expect(audio.headers['content-security-policy']).toBeUndefined();
    } finally {
      const ids = Object.keys(files);
      await prisma.file.deleteMany({ where: { id: { in: ids } } });
      await prisma.entity.deleteMany({ where: { id: { in: ids } } });
      await app.close();
      await prisma.$disconnect();
    }
  });
});
