import { describe, expect, it } from 'vitest';
import { loadDatabaseUrl } from './database-url.ts';

describe('loadDatabaseUrl', () => {
  it('needs no other configuration', () => {
    expect(loadDatabaseUrl({})).toBe('postgresql://ldacapi:ldacapi@localhost:5432/ldacapi');
    expect(loadDatabaseUrl({ NODE_ENV: 'test' })).toBe('postgresql://ldacapi:ldacapi@localhost:5432/ldacapi_test');
    expect(loadDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://prod/ldacapi' })).toBe('postgresql://prod/ldacapi');
  });

  it('requires DATABASE_URL in production, treating empty as unset', () => {
    expect(() => loadDatabaseUrl({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
    expect(() => loadDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
});
