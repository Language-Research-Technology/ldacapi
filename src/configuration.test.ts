import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './configuration.ts';

describe('loadConfig', () => {
  it('runs in development with no environment set', () => {
    const config = loadConfig({});

    expect(config.isDev).toBe(true);
    expect(config.databaseUrl).toBe('postgresql://ldacapi:ldacapi@localhost:5432/ldacapi');
    expect(config.opensearchUrl).toBe('http://localhost:9200');
    expect(config.port).toBe(8080);
    expect(config.ocfl).toEqual({ root: resolve('storage/ocfl'), scratch: resolve('storage/scratch') });
  });

  it('uses the test database and index, and logs nothing, in test', () => {
    const config = loadConfig({ NODE_ENV: 'test' });

    expect(config.databaseUrl).toBe('postgresql://ldacapi:ldacapi@localhost:5432/ldacapi_test');
    expect(config.search.entityIndex).toBe('entities_test');
    expect(config.logLevel).toBe('silent');
  });

  it('reads values from the environment', () => {
    const config = loadConfig({ LDACAPI_PORT: '9000', TOKEN_ADMIN: 'secret', ENTITY_INDEX: 'other' });

    expect(config.port).toBe(9000);
    expect(config.tokenAdmin).toBe('secret');
    expect(config.search.entityIndex).toBe('other');
  });

  it('puts OCFL scratch beside the OCFL root unless set', () => {
    expect(loadConfig({ OCFL_ROOT: '/data/ocfl' }).ocfl).toEqual({ root: '/data/ocfl', scratch: '/data/scratch' });
    expect(loadConfig({ OCFL_ROOT: '/data/ocfl', OCFL_SCRATCH: '/tmp/ocfl' }).ocfl.scratch).toBe('/tmp/ocfl');
  });

  it('treats empty values as unset', () => {
    expect(loadConfig({ TOKEN_ADMIN: '' }).tokenAdmin).toBe('1234-1234-1234-1234');
  });

  it('requires connection details, the admin token and OCFL root in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL[\s\S]*OPENSEARCH_URL[\s\S]*TOKEN_ADMIN[\s\S]*OCFL_ROOT/);
  });

  it('starts in production once the required values are set', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://prod/ldacapi',
      OPENSEARCH_URL: 'http://search:9200',
      TOKEN_ADMIN: 'secret',
      OCFL_ROOT: '/data/ocfl',
    });

    expect(config.isDev).toBe(false);
    expect(config.logLevel).toBe('info');
  });

  it('leaves sign-in off without an upstream issuer', () => {
    const config = loadConfig({});

    expect(config.auth.enabled).toBe(false);
    expect(config.auth.issuer).toBe('http://localhost:8080');
    expect(config.auth.audience).toBe('http://localhost:8080/api');
    expect(config.auth.clients).toEqual([]);
  });

  it('ignores the old relay variables', () => {
    const config = loadConfig({ OIDC_ENDPOINT: 'https://cilogon.org', OIDC_CLIENT_ID: 'oni', OIDC_CLIENT_SECRET: 'secret' });

    expect(config.auth.enabled).toBe(false);
    expect(JSON.stringify(config)).not.toMatch(/cilogon|secret/);
  });

  it('turns sign-in on with complete upstream settings', () => {
    const config = loadConfig({
      OIDC_ISSUER: 'https://api.example.org/',
      OIDC_UPSTREAM_ISSUER: 'https://idp.example.org',
      OIDC_UPSTREAM_CLIENT_ID: 'ldacapi',
      OIDC_UPSTREAM_CLIENT_SECRET: 'secret',
    });

    expect(config.auth.enabled).toBe(true);
    expect(config.auth.issuer).toBe('https://api.example.org');
    expect(config.auth.audience).toBe('https://api.example.org/api');
    expect(config.auth.upstream).toEqual({ issuer: 'https://idp.example.org', clientId: 'ldacapi', clientSecret: 'secret' });
  });

  it('requires the upstream client ID and secret with an upstream issuer', () => {
    expect(() => loadConfig({ OIDC_UPSTREAM_ISSUER: 'https://idp.example.org' })).toThrow(/OIDC_UPSTREAM_CLIENT_ID[\s\S]*OIDC_UPSTREAM_CLIENT_SECRET/);
  });

  it('requires OIDC_ISSUER in production only when sign-in is on', () => {
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://prod/ldacapi',
      OPENSEARCH_URL: 'http://search:9200',
      TOKEN_ADMIN: 'secret',
      OCFL_ROOT: '/data/ocfl',
    };
    const upstream = { OIDC_UPSTREAM_ISSUER: 'https://idp.example.org', OIDC_UPSTREAM_CLIENT_ID: 'ldacapi', OIDC_UPSTREAM_CLIENT_SECRET: 'secret' };

    expect(() => loadConfig(production)).not.toThrow();
    expect(() => loadConfig({ ...production, ...upstream })).toThrow(/OIDC_ISSUER/);
    expect(loadConfig({ ...production, ...upstream, OIDC_ISSUER: 'https://api.example.org' }).auth.issuer).toBe('https://api.example.org');
  });

  it('rejects an OIDC_ISSUER that is not a URL', () => {
    expect(() => loadConfig({ OIDC_ISSUER: 'api.example.org' })).toThrow(/OIDC_ISSUER/);
  });

  it('reads clients from OIDC_CLIENTS, making those without a secret public', () => {
    const config = loadConfig({
      OIDC_CLIENTS: JSON.stringify([
        { client_id: 'oni', redirect_uris: ['https://oni.example.org/callback'], post_logout_redirect_uris: ['https://oni.example.org/'] },
        { client_id: 'portal', client_secret: 'secret', redirect_uris: ['https://portal.example.org/callback'] },
      ]),
    });

    expect(config.auth.clients).toEqual([
      {
        client_id: 'oni',
        redirect_uris: ['https://oni.example.org/callback'],
        post_logout_redirect_uris: ['https://oni.example.org/'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      },
      {
        client_id: 'portal',
        client_secret: 'secret',
        redirect_uris: ['https://portal.example.org/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
      },
    ]);
  });

  it('rejects OIDC_CLIENTS that is not JSON', () => {
    expect(() => loadConfig({ OIDC_CLIENTS: '[{client_id: oni}]' })).toThrow(/Invalid JSON[\s\S]*OIDC_CLIENTS/);
  });

  it('rejects clients without an ID or redirect URIs, or with unknown fields', () => {
    expect(() => loadConfig({ OIDC_CLIENTS: '{"client_id":"oni"}' })).toThrow(/OIDC_CLIENTS/);
    expect(() => loadConfig({ OIDC_CLIENTS: '[{"redirect_uris":["https://oni.example.org/callback"]}]' })).toThrow(/OIDC_CLIENTS[\s\S]*client_id/);
    expect(() => loadConfig({ OIDC_CLIENTS: '[{"client_id":"oni","redirect_uris":[]}]' })).toThrow(/OIDC_CLIENTS[\s\S]*redirect_uris/);
    expect(() => loadConfig({ OIDC_CLIENTS: '[{"client_id":"oni","redirect_uris":["not a url"]}]' })).toThrow(/OIDC_CLIENTS[\s\S]*redirect_uris/);
    expect(() => loadConfig({ OIDC_CLIENTS: '[{"client_id":"oni","redirect_uri":["https://oni.example.org/callback"]}]' })).toThrow(
      /OIDC_CLIENTS[\s\S]*redirect_uri/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow();
  });
});
