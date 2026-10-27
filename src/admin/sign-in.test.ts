import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ADMIN, ALICE as ADMIN_USER, adminTestbed, ISSUER } from '../../test/admin.ts';
import type { TestApp } from '../../test/app.ts';
import type { UpstreamUser } from '../../test/fake-upstream.ts';
import { authorizationRequest, Browser } from '../../test/oidc.ts';

const ALICE: UpstreamUser = { ...ADMIN_USER, name: 'Alice <Admin>' };
const MALLORY: UpstreamUser = { sub: 'mallory@upstream', name: 'Mallory' };

const testbed = adminTestbed();
let app: TestApp;

/** Follows `url` to the upstream provider, signs `user` in there, and follows the way back */
const signIn = async (browser: Browser, url: string, user: UpstreamUser) => {
  const toUpstream = await browser.follow(url);
  expect(new URL(toUpstream.headers.location as string).origin).toBe(testbed.upstream.issuer);
  return browser.follow(testbed.upstream.signIn(toUpstream.headers.location as string, user));
};

beforeAll(async () => {
  ({ app } = await testbed.start({ ADMIN_USERS: ` other@upstream , ${ALICE.sub} ` }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('signing in to the admin pages', () => {
  it('sends a visitor with no session to sign in, then back to the page they asked for', async () => {
    const browser = new Browser(app, ADMIN, ISSUER);

    const first = await browser.get('/admin/?from=test');
    expect(first.statusCode).toBe(303);
    const authorize = new URL(first.headers.location as string);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ISSUER}/oauth/authorize`);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ADMIN}/admin/callback`);

    const page = await signIn(browser, '/admin/?from=test', ALICE);
    expect(browser.url).toBe('/admin/?from=test');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Alice &lt;Admin&gt;');
  });

  it('lets in a user already signed in at our provider without visiting the upstream provider', async () => {
    const browser = new Browser(app, ADMIN, ISSUER);
    const { url } = await authorizationRequest({ client_id: 'oni', redirect_uri: 'http://localhost:5173/callback', scope: 'openid' });
    await signIn(browser, `${ISSUER}${url}`, ALICE);

    const page = await browser.follow('/admin/');
    expect(page.headers.location).toBeUndefined();

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Alice &lt;Admin&gt;');
  });

  it('shows a user who is not an admin their sub and a way to sign out', async () => {
    const browser = new Browser(app, ADMIN, ISSUER);

    const page = await signIn(browser, '/admin/', MALLORY);

    expect(page.statusCode).toBe(403);
    expect(page.body).toContain(MALLORY.sub);
    expect(page.body).toMatch(/<form method="post" action="\/admin\/sign-out">/);
  });

  it('sends a session older than 8 hours to sign in again', async () => {
    const browser = new Browser(app, ADMIN, ISSUER);
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
    const browser = new Browser(app, ADMIN, ISSUER);
    await signIn(browser, '/admin/', ALICE);
    const cookie = browser.cookie('admin_session') ?? '';
    browser.setCookie('admin_session', `${cookie[0] === 'A' ? 'B' : 'A'}${cookie.slice(1)}`);

    const page = await browser.get('/admin/');

    expect(page.statusCode).toBe(303);
    expect(new URL(page.headers.location as string).pathname).toBe('/oauth/authorize');
  });

  it('refuses a callback whose state does not match the sign-in', async () => {
    const browser = new Browser(app, ADMIN, ISSUER);
    const toUpstream = await browser.follow('/admin/');
    let toAdmin = new URL(testbed.upstream.signIn(toUpstream.headers.location as string, ALICE));
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
    const browser = new Browser(app, ADMIN, ISSUER);
    await signIn(browser, '/admin/', ALICE);

    const signedOut = await browser.post('/admin/sign-out', {});

    expect(signedOut.statusCode).toBe(303);
    const endSession = new URL(signedOut.headers.location as string);
    expect(`${endSession.origin}${endSession.pathname}`).toBe(`${ISSUER}/oauth/session/end`);
    expect(endSession.searchParams.get('id_token_hint')).toEqual(expect.any(String));
    expect(endSession.searchParams.get('post_logout_redirect_uri')).toBe(`${ADMIN}/admin/`);
    expect(browser.cookie('admin_session')).toBeUndefined();

    const confirm = await browser.get(endSession.toString());
    const xsrf = confirm.body.match(/name="xsrf" value="([^"]+)"/)?.[1] ?? '';
    const backToAdmin = await browser.post(`${ISSUER}/oauth/session/end/confirm`, { xsrf, logout: 'yes' });
    expect(backToAdmin.headers.location).toBe(`${ADMIN}/admin/`);
    const again = await browser.follow('/admin/');
    expect(new URL(again.headers.location as string).origin).toBe(testbed.upstream.issuer);
  });

  it('refuses a POST with a missing or foreign Origin, including the issuer', async () => {
    const browser = new Browser(app, ADMIN, ISSUER);
    await signIn(browser, '/admin/', ALICE);

    for (const headers of [{}, { origin: 'https://evil.example.org' }, { origin: ISSUER }]) {
      expect((await browser.post('/admin/sign-out', {}, headers)).statusCode).toBe(403);
    }
    expect((await browser.get('/admin/')).statusCode).toBe(200);
  });

  it('is only on the admin origin', async () => {
    const api = new Browser(app, ISSUER);
    for (const path of ['/admin/', '/admin/admin.css', '/admin/callback']) {
      expect((await api.get(path)).statusCode).toBe(404);
    }
    expect((await api.get('/api/version')).statusCode).toBe(200);
    expect((await new Browser(app, ADMIN).get('/api/version')).statusCode).toBe(404);
  });

  it('allows only our own scripts and styles, and no framing', async () => {
    const page = await new Browser(app, ADMIN, ISSUER).get('/admin/');

    const csp = page.headers['content-security-policy'] as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('serves the stylesheet to anyone, and links it from every page', async () => {
    const stylesheet = await new Browser(app, ADMIN, ISSUER).get('/admin/admin.css');
    expect(stylesheet.statusCode).toBe(200);
    expect(stylesheet.headers['content-type']).toMatch(/^text\/css/);

    const link = '<link rel="stylesheet" href="/admin/admin.css">';
    expect((await signIn(new Browser(app, ADMIN, ISSUER), '/admin/', ALICE)).body).toContain(link);
    expect((await signIn(new Browser(app, ADMIN, ISSUER), '/admin/', MALLORY)).body).toContain(link);
  });
});
