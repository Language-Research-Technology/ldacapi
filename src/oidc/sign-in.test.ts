import { createHash, randomBytes } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeUpstream, type UpstreamUser } from '../../test/fake-upstream.ts';
import type { Repository } from '../repository.ts';

const ISSUER = 'http://localhost:8080';
const AUDIENCE = `${ISSUER}/api`;
const REDIRECT_URI = 'http://localhost:5173/callback';
const ONI = { client_id: 'oni', redirect_uris: [REDIRECT_URI] };
const UPSTREAM_CLIENT = { clientId: 'ldacapi', clientSecret: 'upstream-secret' };

const ALICE: UpstreamUser = {
  sub: 'http://cilogon.org/serverA/users/1234',
  name: 'Alice Example',
  email: 'alice@example.org',
  given_name: 'Alice',
  family_name: 'Example',
};

let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
let app: ReturnType<typeof import('../app.ts').buildApp>;
let prisma: typeof import('../prisma.ts').prisma;

const repository = { storage: () => ({ content: {} }) } as unknown as Repository;

/** A browser's cookies, sent with every request to the app */
class Browser {
  private cookies = new Map<string, string>();

  async get(url: string) {
    const { pathname, search } = new URL(url, ISSUER);
    const response = await app.inject({ method: 'GET', url: `${pathname}${search}`, headers: { host: 'localhost:8080', cookie: this.cookieHeader() } });
    this.store(response);
    return response;
  }

  /** Follows redirects within the app, returning the first response that leaves it */
  async follow(url: string) {
    let response = await this.get(url);
    let location = response.headers.location as string | undefined;
    while (response.statusCode >= 300 && response.statusCode < 400 && location && new URL(location, ISSUER).origin === ISSUER) {
      response = await this.get(location);
      location = response.headers.location as string | undefined;
    }
    return response;
  }

  private cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private store(response: LightMyRequestResponse) {
    for (const { name, value, expires, maxAge } of response.cookies as { name: string; value: string; expires?: Date; maxAge?: number }[]) {
      if (maxAge === 0 || (expires && expires.getTime() <= Date.now()) || !value) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }
}

const startAuthorization = async (browser: Browser, params: Record<string, string> = {}) => {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    client_id: ONI.client_id,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid profile email offline_access',
    state: 'oni-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...params,
  });
  const response = await browser.follow(`/oauth/authorize?${query}`);
  return { response, verifier };
};

const signIn = async (user: UpstreamUser, params: Record<string, string> = {}) => {
  const browser = new Browser();
  const { response: toUpstream, verifier } = await startAuthorization(browser, params);
  const returned = await browser.follow(upstream.signIn(toUpstream.headers.location as string, user));
  const redirect = new URL(returned.headers.location as string);
  return { browser, toUpstream, redirect, verifier };
};

const tokenRequest = (params: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { host: 'localhost:8080', 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ client_id: ONI.client_id, ...params }).toString(),
  });

const exchangeCode = async (redirect: URL, verifier: string) =>
  tokenRequest({ grant_type: 'authorization_code', code: redirect.searchParams.get('code') ?? '', redirect_uri: REDIRECT_URI, code_verifier: verifier });

const verify = async (token: string, audience: string) => {
  const jwks = (await app.inject({ method: 'GET', url: '/oauth/jwks', headers: { host: 'localhost:8080' } })).json();
  return (await jwtVerify(token, createLocalJWKSet(jwks), { issuer: ISSUER, audience })).payload;
};

beforeAll(async () => {
  upstream = await startFakeUpstream(UPSTREAM_CLIENT);
  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_CLIENTS = JSON.stringify([ONI]);
  process.env.OIDC_UPSTREAM_ISSUER = upstream.issuer;
  process.env.OIDC_UPSTREAM_CLIENT_ID = UPSTREAM_CLIENT.clientId;
  process.env.OIDC_UPSTREAM_CLIENT_SECRET = UPSTREAM_CLIENT.clientSecret;

  // Imported after the environment is set, as configuration is read on import
  const { config } = await import('../configuration.ts');
  ({ prisma } = await import('../prisma.ts'));
  const { buildApp } = await import('../app.ts');
  const { Client } = await import('@opensearch-project/opensearch');
  const { createSearchBackend } = await import('../indexer/search.ts');
  app = buildApp({ repository, search: createSearchBackend(new Client({ node: config.opensearchUrl })) });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await upstream.close();
});

describe('signing in at the upstream provider', () => {
  it('signs a user in and issues our tokens', async () => {
    const { toUpstream, redirect, verifier } = await signIn(ALICE);

    const upstreamRequest = new URL(toUpstream.headers.location as string);
    expect(`${upstreamRequest.origin}${upstreamRequest.pathname}`).toBe(`${upstream.issuer}/authorize`);
    expect(Object.fromEntries(upstreamRequest.searchParams)).toMatchObject({
      client_id: UPSTREAM_CLIENT.clientId,
      redirect_uri: `${ISSUER}/oauth/callback`,
      response_type: 'code',
      code_challenge_method: 'S256',
    });

    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get('state')).toBe('oni-state');
    expect(redirect.searchParams.get('error')).toBeNull();

    const tokens = await exchangeCode(redirect, verifier);
    expect(tokens.statusCode).toBe(200);
    const { id_token, access_token, refresh_token } = tokens.json();

    expect(await verify(id_token, ONI.client_id)).toMatchObject({
      sub: ALICE.sub,
      name: ALICE.name,
      email: ALICE.email,
      given_name: ALICE.given_name,
      family_name: ALICE.family_name,
    });
    expect(decodeProtectedHeader(access_token).alg).toBe('RS256');
    expect(await verify(access_token, AUDIENCE)).toMatchObject({ sub: ALICE.sub });
    expect(refresh_token).toEqual(expect.any(String));
  });

  it('exchanges a refresh token for a new access token', async () => {
    const { redirect, verifier } = await signIn(ALICE);
    const { refresh_token } = (await exchangeCode(redirect, verifier)).json();

    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token });

    expect(refreshed.statusCode).toBe(200);
    expect(await verify(refreshed.json().access_token, AUDIENCE)).toMatchObject({ sub: ALICE.sub });
    expect(refreshed.json().refresh_token).toEqual(expect.any(String));
  });

  it('ignores scopes it does not define', async () => {
    const { redirect, verifier } = await signIn(ALICE, { scope: 'openid profile email offline_access public' });

    expect(redirect.searchParams.get('error')).toBeNull();
    const tokens = await exchangeCode(redirect, verifier);
    expect(tokens.statusCode).toBe(200);
    expect(tokens.json().scope.split(' ')).not.toContain('public');
  });

  it('keeps the latest details of a user from the upstream provider', async () => {
    const bob = { sub: 'bob@upstream', name: 'Bob Old', email: 'bob@old.example.org', given_name: 'Bob', family_name: 'Old' };
    await signIn(bob);
    const renamed = { ...bob, name: 'Bob New', email: 'bob@new.example.org', family_name: 'New' };
    const { redirect, verifier } = await signIn(renamed);

    const { id_token } = (await exchangeCode(redirect, verifier)).json();

    expect(await verify(id_token, ONI.client_id)).toMatchObject(renamed);
  });

  it('signs nobody in when the upstream provider returns an error', async () => {
    const browser = new Browser();
    const { response } = await startAuthorization(browser);
    const state = new URL(response.headers.location as string).searchParams.get('state') ?? '';

    const returned = await browser.follow(`/oauth/callback?${new URLSearchParams({ error: 'access_denied', state })}`);

    const redirect = new URL(returned.headers.location as string);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('code')).toBeNull();
  });

  it('signs nobody in when the state does not match the sign-in', async () => {
    const browser = new Browser();
    const { response } = await startAuthorization(browser);
    const callback = new URL(upstream.signIn(response.headers.location as string, ALICE));
    callback.searchParams.set('state', 'forged');

    const returned = await browser.follow(callback.toString());

    expect(returned.statusCode).toBe(400);
    expect(returned.headers.location).toBeUndefined();
  });

  it('signs nobody in when the callback reaches a different browser', async () => {
    const { response } = await startAuthorization(new Browser());
    const callback = upstream.signIn(response.headers.location as string, ALICE);

    const returned = await new Browser().follow(callback);

    expect(returned.statusCode).toBe(400);
    expect(returned.headers.location).toBeUndefined();
  });
});
