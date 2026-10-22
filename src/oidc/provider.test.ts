import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Repository } from '../repository.ts';

const ISSUER = 'http://localhost:8080';
const REDIRECT_URI = 'http://localhost:5173/callback';
const ONI = { client_id: 'oni', redirect_uris: [REDIRECT_URI] };

let buildApp: typeof import('../app.ts').buildApp;
let app: ReturnType<typeof buildApp>;
let search: import('arocapi').SearchBackend;
let prisma: typeof import('../prisma.ts').prisma;

const repository = { storage: () => ({ content: {} }) } as unknown as Repository;

const get = (url: string, target = app) => target.inject({ method: 'GET', url, headers: { host: 'localhost:8080' } });

const authorize = (params: Record<string, string>) => {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    client_id: ONI.client_id,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...params,
  });
  return get(`/oauth/authorize?${query}`);
};

beforeAll(async () => {
  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_CLIENTS = JSON.stringify([ONI]);
  process.env.OIDC_UPSTREAM_ISSUER = 'https://idp.example.org';
  process.env.OIDC_UPSTREAM_CLIENT_ID = 'ldacapi';
  process.env.OIDC_UPSTREAM_CLIENT_SECRET = 'secret';

  // Imported after the environment is set, as configuration is read on import
  const { config } = await import('../configuration.ts');
  ({ prisma } = await import('../prisma.ts'));
  ({ buildApp } = await import('../app.ts'));
  const { Client } = await import('@opensearch-project/opensearch');
  const { createSearchBackend } = await import('../indexer/search.ts');
  search = createSearchBackend(new Client({ node: config.opensearchUrl }));
  app = buildApp({ repository, search });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('OIDC provider', () => {
  it('serves discovery with our issuer and endpoints under /oauth/', async () => {
    const response = await get('/.well-known/openid-configuration');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      jwks_uri: `${ISSUER}/oauth/jwks`,
      userinfo_endpoint: `${ISSUER}/oauth/userinfo`,
      end_session_endpoint: `${ISSUER}/oauth/session/end`,
      revocation_endpoint: `${ISSUER}/oauth/token/revocation`,
    });
  });

  it('keeps its signing keys across app builds', async () => {
    const first = await get('/oauth/jwks');
    const other = buildApp({ repository, search });
    const second = await get('/oauth/jwks', other);
    await other.close();

    expect(first.json().keys).toHaveLength(1);
    expect(first.json().keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    expect(first.json().keys[0]).not.toHaveProperty('d');
    expect(second.json()).toEqual(first.json());
  });

  it('rejects an unknown client', async () => {
    const response = await authorize({ client_id: 'unknown' });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('invalid_client');
  });

  it('rejects an unregistered redirect URI', async () => {
    const response = await authorize({ redirect_uri: 'https://evil.example.org/callback' });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('redirect_uri');
  });

  it('requires PKCE from a public client', async () => {
    const response = await authorize({ code_challenge: '', code_challenge_method: '' });

    expect(response.statusCode).toBe(303);
    expect(new URL(response.headers.location as string).searchParams.get('error_description')).toMatch(/PKCE/);
  });

  it('sends a valid request to the interaction route', async () => {
    const response = await authorize({});

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toMatch(/^\/oauth\/interaction\/[\w-]+$/);
  });

  it('resumes an authorisation request in another app build', async () => {
    const started = await authorize({});
    const uid = (started.headers.location as string).split('/').pop();
    const cookie = started.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
    const other = buildApp({ repository, search });

    const resumed = await other.inject({ method: 'GET', url: `/oauth/authorize/${uid}`, headers: { host: 'localhost:8080', cookie } });
    await other.close();

    expect(resumed.statusCode).toBe(303);
    expect(resumed.headers.location).toMatch(/^\/oauth\/interaction\/[\w-]+$/);
  });

  it('does not handle routes outside the provider', async () => {
    const response = await get('/oauth/unknown');

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
