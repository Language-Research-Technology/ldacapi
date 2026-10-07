import { describe, expect, it } from 'vitest';
import { loadConfig } from './configuration.ts';

describe('loadConfig', () => {
  it('runs in development with no environment set', () => {
    const config = loadConfig({});

    expect(config.isDev).toBe(true);
    expect(config.databaseUrl).toBe('postgresql://ldacapi:ldacapi@localhost:5432/ldacapi');
    expect(config.opensearchUrl).toBe('http://localhost:9200');
    expect(config.port).toBe(8080);
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

  it('treats empty values as unset', () => {
    expect(loadConfig({ TOKEN_ADMIN: '' }).tokenAdmin).toBe('1234-1234-1234-1234');
  });

  it('requires connection details and the admin token in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL[\s\S]*OPENSEARCH_URL[\s\S]*TOKEN_ADMIN/);
  });

  it('starts in production once the required values are set', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://prod/ldacapi',
      OPENSEARCH_URL: 'http://search:9200',
      TOKEN_ADMIN: 'secret',
    });

    expect(config.isDev).toBe(false);
    expect(config.logLevel).toBe('info');
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow();
  });
});
