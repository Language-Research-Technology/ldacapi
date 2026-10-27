import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/app.ts';
import { startFakeUpstream, type UpstreamUser } from '../../test/fake-upstream.ts';
import { Browser } from '../../test/oidc.ts';

const ISSUER = 'http://localhost:8080';
const UPSTREAM_CLIENT = { clientId: 'ldacapi', clientSecret: 'upstream-secret' };
const ALICE: UpstreamUser = { sub: 'alice@upstream', name: 'Alice' };
const COOKIE_KEYS = 'a-cookie-key-of-at-least-32-characters';

let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
const running: Awaited<ReturnType<typeof buildTestApp>>[] = [];

/** Starts the app afresh with `env`, as a restart with new configuration would */
const start = async (env: Record<string, string>) => {
  vi.resetModules();
  const started = await buildTestApp({
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENTS: JSON.stringify([{ client_id: 'oni', redirect_uris: ['http://localhost:5173/callback'] }]),
    OIDC_UPSTREAM_ISSUER: upstream.issuer,
    OIDC_UPSTREAM_CLIENT_ID: UPSTREAM_CLIENT.clientId,
    OIDC_UPSTREAM_CLIENT_SECRET: UPSTREAM_CLIENT.clientSecret,
    OIDC_COOKIE_KEYS: COOKIE_KEYS,
    ...env,
  });
  running.push(started);
  return { app: started.app };
};

const signIn = async (app: TestApp, user: UpstreamUser) => {
  const browser = new Browser(app, ISSUER);
  const toUpstream = await browser.follow('/admin/');
  const page = await browser.follow(upstream.signIn(toUpstream.headers.location as string, user));
  return { browser, page };
};

beforeAll(async () => {
  upstream = await startFakeUpstream(UPSTREAM_CLIENT);
});

afterAll(async () => {
  for (const { app, prisma } of running) {
    await app.close();
    await prisma.$disconnect();
  }
  await upstream.close();
});

describe('who is an admin', () => {
  it('lets nobody in when ADMIN_USERS lists nobody', async () => {
    const { app } = await start({ ADMIN_USERS: ' , ' });

    const { page } = await signIn(app, ALICE);

    expect(page.statusCode).toBe(403);
  });

  it('stops an existing session once its user is removed from ADMIN_USERS', async () => {
    const { app: before } = await start({ ADMIN_USERS: ALICE.sub });
    const { browser, page } = await signIn(before, ALICE);
    expect(page.statusCode).toBe(200);

    const { app: after } = await start({});

    expect((await browser.get('/admin/', after)).statusCode).toBe(403);
  });

  it('treats a session from an app with other cookie keys as no session', async () => {
    const { app: other } = await start({ ADMIN_USERS: ALICE.sub, OIDC_COOKIE_KEYS: 'another-cookie-key-of-at-least-32-characters' });
    const { browser } = await signIn(other, ALICE);
    const { app } = await start({ ADMIN_USERS: ALICE.sub });

    const page = await browser.get('/admin/', app);

    expect(page.statusCode).toBe(303);
    expect(new URL(page.headers.location as string).pathname).toBe('/oauth/authorize');
  });
});
