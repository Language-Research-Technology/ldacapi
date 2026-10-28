import { describe, expect, it, vi } from 'vitest';
import { ALICE, adminTestbed } from '../../test/admin.ts';

const COOKIE_KEYS = 'a-cookie-key-of-at-least-32-characters';

const testbed = adminTestbed();
const signIn = testbed.signInAsAdmin;

/** Starts the app afresh with `env`, as a restart with new configuration would */
const start = (env: Record<string, string>) => {
  vi.resetModules();
  return testbed.start({ OIDC_COOKIE_KEYS: COOKIE_KEYS, ...env });
};

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
