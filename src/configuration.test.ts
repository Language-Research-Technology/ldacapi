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

  it('uses the test database and index in test', () => {
    const config = loadConfig({ NODE_ENV: 'test' });

    expect(config.databaseUrl).toBe('postgresql://ldacapi:ldacapi@localhost:5432/ldacapi_test');
    expect(config.search.entityIndex).toBe('entities_test');
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

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow();
  });
});
