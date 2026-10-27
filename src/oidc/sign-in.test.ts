import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestApp, repositoryWithContent, type TestApp } from '../../test/app.ts';
import { startFakeUpstream, type UpstreamUser } from '../../test/fake-upstream.ts';
import { authorizationRequest, Browser } from '../../test/oidc.ts';

const ISSUER = 'http://localhost:8080';
const AUDIENCE = `${ISSUER}/api`;
const REDIRECT_URI = 'http://localhost:5173/callback';
const POST_LOGOUT_REDIRECT_URI = 'http://localhost:5173/';
const ONI = { client_id: 'oni', redirect_uris: [REDIRECT_URI], post_logout_redirect_uris: [POST_LOGOUT_REDIRECT_URI] };
const RESTRICTED = 'https://example.org/licenses/restricted';
const RESTRICTED_FILE = 'http://test/sign-in/restricted.txt';
const UPSTREAM_CLIENT = { clientId: 'ldacapi', clientSecret: 'upstream-secret' };

const ALICE: UpstreamUser = {
  sub: 'http://cilogon.org/serverA/users/1234',
  name: 'Alice Example',
  email: 'alice@example.org',
  given_name: 'Alice',
  family_name: 'Example',
};

let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
let app: TestApp;
let prisma: Awaited<ReturnType<typeof buildTestApp>>['prisma'];
let prefix: string;

// Stands in for REMS, entitling Alice to the restricted licence
let rems: Server;
let remsRequests: IncomingMessage[] = [];

const startAuthorization = async (browser: Browser, params: Record<string, string> = {}) => {
  const { url, verifier } = await authorizationRequest({
    client_id: ONI.client_id,
    redirect_uri: REDIRECT_URI,
    scope: 'openid profile email offline_access',
    state: 'oni-state',
    ...params,
  });
  const response = await browser.follow(url);
  return { response, verifier };
};

const signIn = async (user: UpstreamUser, params: Record<string, string> = {}) => {
  const browser = new Browser(app, ISSUER);
  const { response: toUpstream, verifier } = await startAuthorization(browser, params);
  const returned = await browser.follow(upstream.signIn(toUpstream.headers.location as string, user));
  const redirect = new URL(returned.headers.location as string);
  return { browser, toUpstream, redirect, verifier };
};

const tokenRequest = (params: Record<string, string>, url = '/oauth/token', headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { host: 'localhost:8080', 'content-type': 'application/x-www-form-urlencoded', ...headers },
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
  rems = createServer((request, response) => {
    remsRequests.push(request);
    const user = new URL(request.url ?? '', 'http://rems').searchParams.get('user');
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(user === ALICE.sub ? [{ resource: RESTRICTED }] : []));
  });
  await new Promise<void>((resolve) => rems.listen(0, '127.0.0.1', resolve));

  let config: Awaited<ReturnType<typeof buildTestApp>>['config'];
  ({ app, prisma, config } = await buildTestApp(
    {
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENTS: JSON.stringify([ONI]),
      OIDC_UPSTREAM_ISSUER: upstream.issuer,
      OIDC_UPSTREAM_CLIENT_ID: UPSTREAM_CLIENT.clientId,
      OIDC_UPSTREAM_CLIENT_SECRET: UPSTREAM_CLIENT.clientSecret,
      REMS_ENDPOINT: `http://127.0.0.1:${(rems.address() as AddressInfo).port}`,
    },
    { repository: repositoryWithContent },
  ));
  ({ prefix } = config);

  await prisma.entity.create({
    data: {
      id: RESTRICTED_FILE,
      name: RESTRICTED_FILE,
      description: '',
      entityType: 'http://schema.org/MediaObject',
      metadataLicenseId: 'https://creativecommons.org/licenses/by/4.0/',
      contentLicenseId: RESTRICTED,
    },
  });
  await prisma.file.create({ data: { id: RESTRICTED_FILE, filename: 'restricted.txt', mediaType: 'text/plain', size: 7 } });
});

afterAll(async () => {
  await prisma.file.deleteMany({ where: { id: RESTRICTED_FILE } });
  await prisma.entity.deleteMany({ where: { id: RESTRICTED_FILE } });
  await app.close();
  await prisma.$disconnect();
  await upstream.close();
  await new Promise((resolve) => rems.close(resolve));
});

describe('signing in at the upstream provider', () => {
  it('signs a user in from discovery, and their tokens unlock restricted content', async () => {
    const discovery = (await app.inject({ method: 'GET', url: '/.well-known/openid-configuration', headers: { host: 'localhost:8080' } })).json();
    const tokenEndpoint = new URL(discovery.token_endpoint).pathname;
    const browser = new Browser(app, ISSUER);
    const { url, verifier } = await authorizationRequest(
      { client_id: ONI.client_id, redirect_uri: REDIRECT_URI, scope: 'openid profile email', state: 'oni-state' },
      new URL(discovery.authorization_endpoint).pathname,
    );
    const toUpstream = await browser.follow(url);

    const upstreamRequest = new URL(toUpstream.headers.location as string);
    expect(`${upstreamRequest.origin}${upstreamRequest.pathname}`).toBe(`${upstream.issuer}/authorize`);
    expect(Object.fromEntries(upstreamRequest.searchParams)).toMatchObject({
      client_id: UPSTREAM_CLIENT.clientId,
      redirect_uri: `${ISSUER}/oauth/callback`,
      response_type: 'code',
      code_challenge_method: 'S256',
    });

    const returned = await browser.follow(upstream.signIn(toUpstream.headers.location as string, ALICE));
    const redirect = new URL(returned.headers.location as string);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get('state')).toBe('oni-state');
    expect(redirect.searchParams.get('error')).toBeNull();

    const tokens = await tokenRequest(
      { grant_type: 'authorization_code', code: redirect.searchParams.get('code') ?? '', redirect_uri: REDIRECT_URI, code_verifier: verifier },
      tokenEndpoint,
    );
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

    const restricted = (bearer: string) =>
      app.inject({ method: 'GET', url: `${prefix}/file/${encodeURIComponent(RESTRICTED_FILE)}`, headers: { authorization: `Bearer ${bearer}` } });
    remsRequests = [];
    const content = await restricted(access_token);
    expect(content.statusCode).toBe(200);
    expect(content.body).toBe('content');
    expect(remsRequests.map((request) => request.url)).toEqual([`/entitlements?user=${encodeURIComponent(ALICE.sub)}`]);

    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token }, tokenEndpoint);
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().refresh_token).not.toBe(refresh_token);
    expect((await restricted(refreshed.json().access_token)).statusCode).toBe(200);
  });

  it('signs in after the sign-in page is loaded twice', async () => {
    const browser = new Browser(app, ISSUER);
    const { url, verifier } = await authorizationRequest({ client_id: ONI.client_id, redirect_uri: REDIRECT_URI, scope: 'openid' });
    const interaction = (await browser.get(url)).headers.location as string;
    const first = await browser.get(interaction);
    await browser.get(interaction);

    const returned = await browser.follow(upstream.signIn(first.headers.location as string, ALICE));

    const redirect = new URL(returned.headers.location as string);
    expect(redirect.searchParams.get('error')).toBeNull();
    expect((await exchangeCode(redirect, verifier)).statusCode).toBe(200);
  });

  it('uses the same upstream checks for parallel loads of the sign-in page', async () => {
    const browser = new Browser(app, ISSUER);
    const { url, verifier } = await authorizationRequest({ client_id: ONI.client_id, redirect_uri: REDIRECT_URI, scope: 'openid' });
    const interaction = (await browser.get(url)).headers.location as string;
    // Holds each load's lookup of the checks until both have made it, or briefly, so they overlap
    const { PrismaAdapter } = await import('./adapter.ts');
    const find = PrismaAdapter.prototype.find;
    const waiting: (() => void)[] = [];
    const spy = vi.spyOn(PrismaAdapter.prototype, 'find').mockImplementation(async function (this: InstanceType<typeof PrismaAdapter>, id) {
      if (Reflect.get(this, 'model') === 'UpstreamChecks') {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 2) {
            for (const release of waiting) {
              release();
            }
          }
          setTimeout(resolve, 200);
        });
      }
      return find.call(this, id);
    });

    const loads = await Promise.all([browser.get(interaction), browser.get(interaction)]).finally(() => spy.mockRestore());

    const [first, second] = loads.map((load) => new URL(load.headers.location as string).searchParams);
    expect(first?.get('code_challenge')).toEqual(expect.any(String));
    expect(second?.get('code_challenge')).toBe(first?.get('code_challenge'));
    expect(second?.get('nonce')).toBe(first?.get('nonce'));
    const returned = await browser.follow(upstream.signIn(loads[1]?.headers.location as string, ALICE));
    const redirect = new URL(returned.headers.location as string);
    expect(redirect.searchParams.get('error')).toBeNull();
    expect((await exchangeCode(redirect, verifier)).statusCode).toBe(200);
  });

  it('gives a client only the claims of the scopes it asks for', async () => {
    const { redirect, verifier } = await signIn(ALICE, { scope: 'openid' });

    const claims = await verify((await exchangeCode(redirect, verifier)).json().id_token, ONI.client_id);

    expect(claims.sub).toBe(ALICE.sub);
    expect(claims).not.toHaveProperty('name');
    expect(claims).not.toHaveProperty('email');
  });

  it('signs out without a confirmation page and returns to the client', async () => {
    const { browser, redirect, verifier } = await signIn(ALICE);
    const { id_token } = (await exchangeCode(redirect, verifier)).json();

    const page = await browser.get(
      `/oauth/session/end?${new URLSearchParams({ id_token_hint: id_token, post_logout_redirect_uri: POST_LOGOUT_REDIRECT_URI })}`,
    );
    expect(page.body).toContain('name="logout" value="yes"');
    expect(page.body).toContain('.submit()');
    expect(page.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    const xsrf = page.body.match(/name="xsrf" value="([^"]+)"/)?.[1] ?? '';
    const signedOut = await browser.post('/oauth/session/end/confirm', { xsrf, logout: 'yes' });

    expect(signedOut.statusCode).toBe(303);
    expect(signedOut.headers.location).toBe(POST_LOGOUT_REDIRECT_URI);
    const { url } = await authorizationRequest({ client_id: ONI.client_id, redirect_uri: REDIRECT_URI, scope: 'openid', prompt: 'none' });
    const silent = new URL((await browser.follow(url)).headers.location as string);
    expect(`${silent.origin}${silent.pathname}`).toBe(REDIRECT_URI);
    expect(silent.searchParams.get('error')).toBe('login_required');
  });

  it('asks before signing out when the request does not name the signed-in user', async () => {
    const { browser } = await signIn(ALICE);

    const page = await browser.get(
      `/oauth/session/end?${new URLSearchParams({ client_id: ONI.client_id, post_logout_redirect_uri: POST_LOGOUT_REDIRECT_URI })}`,
    );

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<button type="submit"');
    expect(page.body).not.toContain('<script');
    expect(page.headers['content-security-policy']).toBe("frame-ancestors 'none'");
  });

  it('refuses a code used twice', async () => {
    const { redirect, verifier } = await signIn(ALICE);
    await exchangeCode(redirect, verifier);

    const replayed = await exchangeCode(redirect, verifier);

    expect(replayed.statusCode).toBe(400);
    expect(replayed.json().error).toBe('invalid_grant');
  });

  it('exchanges a refresh token for a new access token', async () => {
    const { redirect, verifier } = await signIn(ALICE);
    const { refresh_token } = (await exchangeCode(redirect, verifier)).json();

    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token });

    expect(refreshed.statusCode).toBe(200);
    expect(await verify(refreshed.json().access_token, AUDIENCE)).toMatchObject({ sub: ALICE.sub });
    expect(refreshed.json().refresh_token).toEqual(expect.any(String));
  });

  it("allows cross-origin token requests only from the client's redirect origins", async () => {
    const origin = new URL(REDIRECT_URI).origin;
    const { redirect, verifier } = await signIn(ALICE);
    const code = { grant_type: 'authorization_code', code: redirect.searchParams.get('code') ?? '', redirect_uri: REDIRECT_URI, code_verifier: verifier };

    const tokens = await tokenRequest(code, undefined, { origin });
    expect(tokens.statusCode).toBe(200);
    expect(tokens.headers['access-control-allow-origin']).toBe(origin);
    const refresh = { grant_type: 'refresh_token', refresh_token: tokens.json().refresh_token };
    const refreshed = await tokenRequest(refresh, undefined, { origin });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.headers['access-control-allow-origin']).toBe(origin);

    const other = await signIn(ALICE);
    const foreign = 'https://evil.example.org';
    const otherCode = { ...code, code: other.redirect.searchParams.get('code') ?? '', code_verifier: other.verifier };
    const refusals = [
      await tokenRequest(otherCode, undefined, { origin: foreign }),
      await tokenRequest({ ...refresh, refresh_token: refreshed.json().refresh_token }, undefined, { origin: foreign }),
    ];
    for (const refused of refusals) {
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error_description).toBe(`origin ${foreign} not allowed for client: ${ONI.client_id}`);
      expect(refused.headers['access-control-allow-origin']).toBeUndefined();
    }
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
    const browser = new Browser(app, ISSUER);
    const { response } = await startAuthorization(browser);
    const state = new URL(response.headers.location as string).searchParams.get('state') ?? '';

    const returned = await browser.follow(`/oauth/callback?${new URLSearchParams({ error: 'access_denied', state })}`);

    const redirect = new URL(returned.headers.location as string);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('code')).toBeNull();
  });

  it('signs nobody in when the state does not match the sign-in', async () => {
    const browser = new Browser(app, ISSUER);
    const { response } = await startAuthorization(browser);
    const callback = new URL(upstream.signIn(response.headers.location as string, ALICE));
    callback.searchParams.set('state', 'forged');

    const returned = await browser.follow(callback.toString());

    expect(returned.statusCode).toBe(400);
    expect(returned.headers.location).toBeUndefined();
  });

  it('signs nobody in when the callback reaches a different browser', async () => {
    const { response } = await startAuthorization(new Browser(app, ISSUER));
    const callback = upstream.signIn(response.headers.location as string, ALICE);

    const returned = await new Browser(app, ISSUER).follow(callback);

    expect(returned.statusCode).toBe(400);
    expect(returned.headers.location).toBeUndefined();
  });
});
