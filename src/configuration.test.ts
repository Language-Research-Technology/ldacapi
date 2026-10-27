import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './configuration.ts';
import { generateCookieKey, generateSigningKey, publicJwks } from './oidc/keys.ts';

const ONI = { client_id: 'oni', redirect_uris: ['https://oni.example.org/callback'] };
const UPSTREAM = {
  OIDC_UPSTREAM_ISSUER: 'https://idp.example.org',
  OIDC_UPSTREAM_CLIENT_ID: 'ldacapi',
  OIDC_UPSTREAM_CLIENT_SECRET: 'secret',
  OIDC_CLIENTS: JSON.stringify([ONI]),
};
const SIGNING_KEY = generateSigningKey();
const OLD_SIGNING_KEY = generateSigningKey();
const COOKIE_KEY = generateCookieKey();
const KEYS = { OIDC_SIGNING_KEYS: JSON.stringify({ keys: [SIGNING_KEY] }), OIDC_COOKIE_KEYS: COOKIE_KEY };
const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://prod/ldacapi',
  OPENSEARCH_URL: 'http://search:9200',
  TOKEN_ADMIN: 'secret',
  OCFL_ROOT: '/data/ocfl',
};

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
    const config = loadConfig(PRODUCTION);

    expect(config.isDev).toBe(false);
    expect(config.logLevel).toBe('info');
  });

  it('leaves sign-in off without an upstream issuer', () => {
    expect(loadConfig({}).auth).toBeUndefined();
  });

  it('turns sign-in on with complete upstream settings', () => {
    const config = loadConfig({ ...UPSTREAM, ...KEYS, OIDC_ISSUER: 'https://api.example.org/' });

    expect(config.auth).toEqual({
      issuer: 'https://api.example.org',
      audience: 'https://api.example.org/api',
      clients: [ONI],
      upstream: { issuer: 'https://idp.example.org', clientId: 'ldacapi', clientSecret: 'secret' },
      signingKeys: [SIGNING_KEY],
      cookieKeys: [COOKIE_KEY],
    });
  });

  it('requires the upstream client ID and secret with an upstream issuer', () => {
    expect(() => loadConfig({ OIDC_UPSTREAM_ISSUER: 'https://idp.example.org' })).toThrow(/OIDC_UPSTREAM_CLIENT_ID[\s\S]*OIDC_UPSTREAM_CLIENT_SECRET/);
  });

  it('requires a client with an upstream issuer', () => {
    expect(() => loadConfig({ ...UPSTREAM, OIDC_CLIENTS: '[]' })).toThrow(/at least one client[\s\S]*OIDC_CLIENTS/);
    expect(() => loadConfig({ ...UPSTREAM, OIDC_CLIENTS: undefined })).toThrow(/OIDC_CLIENTS/);
  });

  it('requires OIDC_ISSUER in production only when sign-in is on', () => {
    expect(() => loadConfig(PRODUCTION)).not.toThrow();
    expect(() => loadConfig({ ...PRODUCTION, ...UPSTREAM })).toThrow(/OIDC_ISSUER/);
    expect(loadConfig({ ...PRODUCTION, ...UPSTREAM, ...KEYS, OIDC_ISSUER: 'https://api.example.org' }).auth?.issuer).toBe('https://api.example.org');
  });

  it('requires an https upstream issuer in production only', () => {
    const upstream = { ...UPSTREAM, ...KEYS, OIDC_ISSUER: 'https://api.example.org', OIDC_UPSTREAM_ISSUER: 'http://idp.example.org' };

    expect(() => loadConfig({ ...PRODUCTION, ...upstream })).toThrow(/OIDC_UPSTREAM_ISSUER/);
    expect(loadConfig(upstream).auth?.upstream.issuer).toBe('http://idp.example.org');
  });

  it('rejects an OIDC_ISSUER that is not a URL', () => {
    expect(() => loadConfig({ OIDC_ISSUER: 'api.example.org' })).toThrow(/OIDC_ISSUER/);
  });

  it('rejects an OIDC_ISSUER with a path, query or hash', () => {
    for (const issuer of ['https://api.example.org/oidc', 'https://api.example.org/?x=1', 'https://api.example.org/#x']) {
      expect(() => loadConfig({ OIDC_ISSUER: issuer })).toThrow(/origin[\s\S]*OIDC_ISSUER/);
    }
  });

  it('requires an https OIDC_ISSUER in production', () => {
    expect(() => loadConfig({ ...PRODUCTION, ...UPSTREAM, OIDC_ISSUER: 'http://api.example.org' })).toThrow(/https[\s\S]*OIDC_ISSUER/);
  });

  it('reads clients from OIDC_CLIENTS', () => {
    const config = loadConfig({
      ...UPSTREAM,
      OIDC_CLIENTS: JSON.stringify([
        { client_id: 'oni', redirect_uris: ['https://oni.example.org/callback'] },
        { client_id: 'portal', client_secret: 'secret', redirect_uris: ['https://portal.example.org/callback'] },
      ]),
    });

    expect(config.auth?.clients).toEqual([
      { client_id: 'oni', redirect_uris: ['https://oni.example.org/callback'] },
      { client_id: 'portal', client_secret: 'secret', redirect_uris: ['https://portal.example.org/callback'] },
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

  describe('OIDC keys', () => {
    const withKeys = (keys: Record<string, string | undefined>) => loadConfig({ ...UPSTREAM, ...KEYS, ...keys }).auth;
    const signingKeys = (...keys: object[]) => JSON.stringify({ keys });

    it('signs with the first signing key and keeps the rest for verifying', () => {
      expect(withKeys({ OIDC_SIGNING_KEYS: signingKeys(SIGNING_KEY, OLD_SIGNING_KEY) })?.signingKeys).toEqual([SIGNING_KEY, OLD_SIGNING_KEY]);
    });

    it('reads comma-separated cookie keys in order', () => {
      const old = generateCookieKey();

      expect(withKeys({ OIDC_COOKIE_KEYS: `${COOKIE_KEY}, ${old}` })?.cookieKeys).toEqual([COOKIE_KEY, old]);
    });

    it('rejects signing keys that are not JSON', () => {
      expect(() => withKeys({ OIDC_SIGNING_KEYS: '{keys: []}' })).toThrow(/Invalid JSON[\s\S]*OIDC_SIGNING_KEYS/);
    });

    it('rejects a JWKS with no keys', () => {
      expect(() => withKeys({ OIDC_SIGNING_KEYS: signingKeys() })).toThrow(/at least one key[\s\S]*OIDC_SIGNING_KEYS/);
    });

    it('rejects a public key', () => {
      expect(() => withKeys({ OIDC_SIGNING_KEYS: signingKeys(...publicJwks([SIGNING_KEY]).keys) })).toThrow(/Not a valid RSA private key/);
    });

    it('rejects a key without a kid, or not for RS256', () => {
      const { kid: _kid, ...withoutKid } = SIGNING_KEY;

      expect(() => withKeys({ OIDC_SIGNING_KEYS: signingKeys(withoutKid) })).toThrow(/OIDC_SIGNING_KEYS\.keys\[0\]\.kid/);
      expect(() => withKeys({ OIDC_SIGNING_KEYS: signingKeys({ ...SIGNING_KEY, alg: 'RS512' }) })).toThrow(/OIDC_SIGNING_KEYS\.keys\[0\]\.alg/);
    });

    it('rejects a key whose private members do not form a key', () => {
      expect(() => withKeys({ OIDC_SIGNING_KEYS: signingKeys({ ...SIGNING_KEY, n: OLD_SIGNING_KEY.n }) })).toThrow(/Not a valid RSA private key/);
    });

    it('rejects a cookie key shorter than 32 characters', () => {
      expect(() => withKeys({ OIDC_COOKIE_KEYS: `${COOKIE_KEY},too-short` })).toThrow(/at least 32 characters[\s\S]*OIDC_COOKIE_KEYS/);
    });

    it('requires both in production when sign-in is on', () => {
      const production = { ...PRODUCTION, ...UPSTREAM, OIDC_ISSUER: 'https://api.example.org' };

      expect(() => loadConfig(production)).toThrow(/OIDC_SIGNING_KEYS[\s\S]*OIDC_COOKIE_KEYS/);
      expect(() => loadConfig({ ...production, OIDC_SIGNING_KEYS: KEYS.OIDC_SIGNING_KEYS })).toThrow(/OIDC_COOKIE_KEYS/);
      expect(loadConfig({ ...production, ...KEYS }).auth?.signingKeys).toEqual([SIGNING_KEY]);
    });

    it('generates throwaway keys when unset in test and development', () => {
      for (const NODE_ENV of ['test', 'development']) {
        const auth = loadConfig({ ...UPSTREAM, NODE_ENV }).auth;

        expect(auth?.signingKeys).toEqual([expect.objectContaining({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: expect.any(String), d: expect.any(String) })]);
        expect(auth?.cookieKeys).toEqual([expect.stringMatching(/^[\w-]{43}$/)]);
      }
    });
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow();
  });
});
