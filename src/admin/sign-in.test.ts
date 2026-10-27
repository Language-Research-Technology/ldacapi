import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/app.ts';
import { startFakeUpstream, type UpstreamUser } from '../../test/fake-upstream.ts';
import { authorizationRequest, Browser } from '../../test/oidc.ts';

const ISSUER = 'http://localhost:8080';
const UPSTREAM_CLIENT = { clientId: 'ldacapi', clientSecret: 'upstream-secret' };
const ALICE: UpstreamUser = { sub: 'alice@upstream', name: 'Alice <Admin>' };
const MALLORY: UpstreamUser = { sub: 'mallory@upstream', name: 'Mallory' };

let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
let app: TestApp;
let prisma: Awaited<ReturnType<typeof buildTestApp>>['prisma'];

/** Follows `url` to the upstream provider, signs `user` in there, and follows the way back */
const signIn = async (browser: Browser, url: string, user: UpstreamUser) => {
  const toUpstream = await browser.follow(url);
  expect(new URL(toUpstream.headers.location as string).origin).toBe(upstream.issuer);
  return browser.follow(upstream.signIn(toUpstream.headers.location as string, user));
};

beforeAll(async () => {
  upstream = await startFakeUpstream(UPSTREAM_CLIENT);
  ({ app, prisma } = await buildTestApp({
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENTS: JSON.stringify([{ client_id: 'oni', redirect_uris: ['http://localhost:5173/callback'] }]),
    OIDC_UPSTREAM_ISSUER: upstream.issuer,
    OIDC_UPSTREAM_CLIENT_ID: UPSTREAM_CLIENT.clientId,
    OIDC_UPSTREAM_CLIENT_SECRET: UPSTREAM_CLIENT.clientSecret,
    ADMIN_USERS: ` other@upstream , ${ALICE.sub} `,
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await upstream.close();
});

describe('signing in to the admin pages', () => {
  it('sends a visitor with no session to sign in, then back to the page they asked for', async () => {
    const browser = new Browser(app, ISSUER);

    const first = await browser.get('/admin/?from=test');
    expect(first.statusCode).toBe(303);
    const authorize = new URL(first.headers.location as string, ISSUER);
    expect(authorize.pathname).toBe('/oauth/authorize');

    const page = await signIn(browser, '/admin/?from=test', ALICE);
    expect(browser.url).toBe('/admin/?from=test');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Alice &lt;Admin&gt;');
  });

  it('lets in a user already signed in at our provider without visiting the upstream provider', async () => {
    const browser = new Browser(app, ISSUER);
    const { url } = await authorizationRequest({ client_id: 'oni', redirect_uri: 'http://localhost:5173/callback', scope: 'openid' });
    await signIn(browser, url, ALICE);

    const page = await browser.follow('/admin/');

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Alice &lt;Admin&gt;');
  });

  it('shows a user who is not an admin their sub and a way to sign out', async () => {
    const browser = new Browser(app, ISSUER);

    const page = await signIn(browser, '/admin/', MALLORY);

    expect(page.statusCode).toBe(403);
    expect(page.body).toContain(MALLORY.sub);
    expect(page.body).toMatch(/<form method="post" action="\/admin\/sign-out">/);
  });

  it('sends a session older than 8 hours to sign in again', async () => {
    const browser = new Browser(app, ISSUER);
    await signIn(browser, '/admin/', ALICE);
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000 - 60 * 1000);
    expect((await browser.get('/admin/')).statusCode).toBe(200);
    vi.setSystemTime(Date.now() + 60 * 1000);
    const expired = await browser.get('/admin/');

    expect(expired.statusCode).toBe(303);
    expect(new URL(expired.headers.location as string).pathname).toBe('/oauth/authorize');
  });

  it('treats a tampered session cookie as no session', async () => {
    const browser = new Browser(app, ISSUER);
    await signIn(browser, '/admin/', ALICE);
    const cookie = browser.cookie('admin_session') ?? '';
    browser.setCookie('admin_session', `${cookie[0] === 'A' ? 'B' : 'A'}${cookie.slice(1)}`);

    const page = await browser.get('/admin/');

    expect(page.statusCode).toBe(303);
    expect(new URL(page.headers.location as string).pathname).toBe('/oauth/authorize');
  });

  it('refuses a callback whose state does not match the sign-in', async () => {
    const browser = new Browser(app, ISSUER);
    const toUpstream = await browser.follow('/admin/');
    let toAdmin = new URL(upstream.signIn(toUpstream.headers.location as string, ALICE));
    while (toAdmin.pathname !== '/admin/callback') {
      toAdmin = new URL((await browser.get(toAdmin.toString())).headers.location as string, ISSUER);
    }
    toAdmin.searchParams.set('state', 'forged');

    const refused = await browser.get(toAdmin.toString());

    expect(refused.statusCode).toBe(400);
    expect(refused.headers.location).toBeUndefined();
    expect((await browser.get('/admin/')).statusCode).toBe(303);
  });

  it('signs out of the admin pages and our provider', async () => {
    const browser = new Browser(app, ISSUER);
    await signIn(browser, '/admin/', ALICE);

    const signedOut = await browser.post('/admin/sign-out', {});

    expect(signedOut.statusCode).toBe(303);
    const endSession = new URL(signedOut.headers.location as string);
    expect(`${endSession.origin}${endSession.pathname}`).toBe(`${ISSUER}/oauth/session/end`);
    expect(endSession.searchParams.get('id_token_hint')).toEqual(expect.any(String));
    expect(endSession.searchParams.get('post_logout_redirect_uri')).toBe(`${ISSUER}/admin/`);
    expect(browser.cookie('admin_session')).toBeUndefined();

    const confirm = await browser.get(endSession.toString());
    const xsrf = confirm.body.match(/name="xsrf" value="([^"]+)"/)?.[1] ?? '';
    const backToAdmin = await browser.post('/oauth/session/end/confirm', { xsrf, logout: 'yes' });
    expect(backToAdmin.headers.location).toBe(`${ISSUER}/admin/`);
    const again = await browser.follow('/admin/');
    expect(new URL(again.headers.location as string).origin).toBe(upstream.issuer);
  });

  it('refuses a POST with a missing or foreign Origin', async () => {
    const browser = new Browser(app, ISSUER);
    await signIn(browser, '/admin/', ALICE);

    for (const headers of [{}, { origin: 'https://evil.example.org' }]) {
      expect((await browser.post('/admin/sign-out', {}, headers)).statusCode).toBe(403);
    }
    expect((await browser.get('/admin/')).statusCode).toBe(200);
  });

  it('allows only our own scripts and styles, and no framing', async () => {
    const page = await new Browser(app, ISSUER).get('/admin/');

    const csp = page.headers['content-security-policy'] as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('serves the stylesheet to anyone, and links it from every page', async () => {
    const stylesheet = await new Browser(app, ISSUER).get('/admin/admin.css');
    expect(stylesheet.statusCode).toBe(200);
    expect(stylesheet.headers['content-type']).toMatch(/^text\/css/);

    const link = '<link rel="stylesheet" href="/admin/admin.css">';
    expect((await signIn(new Browser(app, ISSUER), '/admin/', ALICE)).body).toContain(link);
    expect((await signIn(new Browser(app, ISSUER), '/admin/', MALLORY)).body).toContain(link);
  });
});
