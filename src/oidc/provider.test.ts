import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/app.ts';
import { authorizationRequest, Browser } from '../../test/oidc.ts';
import type { PrismaAdapter as Adapter } from './adapter.ts';
import { generateSigningKey } from './keys.ts';

const logs = vi.hoisted(() => [] as { msg: string }[]);
vi.mock('../logger.ts', async () => (await import('../../test/logs.ts')).capturingLogger(logs, 'error'));

const ISSUER = 'http://localhost:8080';
const REDIRECT_URI = 'http://localhost:5173/callback';
const ONI = { client_id: 'oni', redirect_uris: [REDIRECT_URI] };
const SIGNING_KEYS = [generateSigningKey(), generateSigningKey()];

let app: TestApp;
let build: () => TestApp;
let prisma: Awaited<ReturnType<typeof buildTestApp>>['prisma'];
// Imported once configuration has been read with sign-in on
let PrismaAdapter: typeof Adapter;

const get = (url: string, target = app) => target.inject({ method: 'GET', url, headers: { host: 'localhost:8080' } });

const authorize = async (params: Record<string, string>, browser = new Browser(app, ISSUER)) => {
  const { url } = await authorizationRequest({ client_id: ONI.client_id, redirect_uri: REDIRECT_URI, scope: 'openid', ...params });
  return browser.get(url);
};

beforeAll(async () => {
  ({ app, build, prisma } = await buildTestApp({
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENTS: JSON.stringify([ONI]),
    OIDC_UPSTREAM_ISSUER: 'https://idp.example.org',
    OIDC_UPSTREAM_CLIENT_ID: 'ldacapi',
    OIDC_UPSTREAM_CLIENT_SECRET: 'secret',
    OIDC_SIGNING_KEYS: JSON.stringify({ keys: SIGNING_KEYS }),
  }));
  ({ PrismaAdapter } = await import('./adapter.ts'));
});

/** Makes storage fail whenever oidc-provider reads `model` */
const failReading = (model: string) => {
  const find = PrismaAdapter.prototype.find;
  vi.spyOn(PrismaAdapter.prototype, 'find').mockImplementation(function (this: Adapter, id) {
    return Reflect.get(this, 'model') === model ? Promise.reject(new Error('storage is down')) : find.call(this, id);
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('OIDC provider', () => {
  const endpoints = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    jwks_uri: `${ISSUER}/oauth/jwks`,
    end_session_endpoint: `${ISSUER}/oauth/session/end`,
    revocation_endpoint: `${ISSUER}/oauth/token/revocation`,
  };

  it('serves discovery with our issuer and endpoints under /oauth/', async () => {
    const response = await get('/.well-known/openid-configuration');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject(endpoints);
    expect(response.json()).not.toHaveProperty('userinfo_endpoint');
  });

  it('lists endpoints at our issuer whatever host the request names', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/openid-configuration',
      headers: { host: 'evil.example.org', 'x-forwarded-host': 'evil.example.org', 'x-forwarded-proto': 'https' },
    });

    expect(response.json()).toMatchObject(endpoints);
  });

  it('lists the public half of every configured signing key at the discovered jwks_uri', async () => {
    const { jwks_uri } = (await get('/.well-known/openid-configuration')).json();
    const { keys } = (await get(new URL(jwks_uri).pathname)).json();

    expect(keys).toEqual(SIGNING_KEYS.map(({ kty, n, e, kid }) => ({ kty, n, e, kid, alg: 'RS256', use: 'sig' })));
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

  it('signs its cookies', async () => {
    const response = await authorize({});

    const names = (response.cookies as { name: string }[]).map(({ name }) => name);
    expect(names).toContain('_interaction');
    expect(names.filter((name) => !name.endsWith('.sig')).map((name) => `${name}.sig`)).toEqual(names.filter((name) => name.endsWith('.sig')));
  });

  it('resumes an authorisation request in another app build', async () => {
    const browser = new Browser(app, ISSUER);
    const started = await authorize({}, browser);
    const uid = (started.headers.location as string).split('/').pop();
    const other = build();

    const resumed = await browser.get(`/oauth/authorize/${uid}`, other);
    await other.close();

    expect(resumed.statusCode).toBe(303);
    expect(resumed.headers.location).toMatch(/^\/oauth\/interaction\/[\w-]+$/);
  });

  it('does not handle routes outside the provider', async () => {
    const response = await get('/oauth/unknown');

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('refuses the sign-in page to a browser that did not start the sign-in', async () => {
    const interaction = (await authorize({})).headers.location as string;

    const response = await get(interaction);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe('Sign-in has expired or was started elsewhere');
  });

  it('refuses the sign-in page once its upstream checks have expired', async () => {
    const browser = new Browser(app, ISSUER);
    const interaction = (await authorize({}, browser)).headers.location as string;
    const uid = interaction.split('/').pop() ?? '';
    await new PrismaAdapter('UpstreamChecks').upsert(uid, { checks: { state: uid, codeVerifier: 'v', nonce: 'n' } }, -1);

    const response = await browser.get(interaction);

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe('Sign-in has expired or was started elsewhere');
  });

  it('refuses an upstream callback with no state', async () => {
    const response = await get('/oauth/callback?code=abc');

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe('Missing state');
  });

  it('signs out a visitor who is not signed in without asking', async () => {
    const browser = new Browser(app, ISSUER);
    const page = await browser.get(`/oauth/session/end?${new URLSearchParams({ client_id: ONI.client_id })}`);
    const xsrf = page.body.match(/name="xsrf" value="([^"]+)"/)?.[1] ?? '';

    expect(page.body).toContain('.submit()');
    const signedOut = await browser.post('/oauth/session/end/confirm', { xsrf, logout: 'yes' });
    expect(signedOut.statusCode).toBe(303);
    expect(new URL(signedOut.headers.location as string).pathname).toBe('/oauth/session/end/success');
  });

  it('fails the sign-in page when its storage fails', async () => {
    const browser = new Browser(app, ISSUER);
    const interaction = (await authorize({}, browser)).headers.location as string;
    failReading('Interaction');

    expect((await browser.get(interaction)).statusCode).toBe(500);
  });

  it('logs a failure inside the provider', async () => {
    const browser = new Browser(app, ISSUER);
    const uid = ((await authorize({}, browser)).headers.location as string).split('/').pop();
    failReading('Interaction');

    expect((await browser.get(`/oauth/authorize/${uid}`)).statusCode).toBe(500);
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'OIDC provider error', err: expect.objectContaining({ message: 'storage is down' }) }));
  });
});
