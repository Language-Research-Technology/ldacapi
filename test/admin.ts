import { afterAll, beforeAll, vi } from 'vitest';
import { initRepository, type Repository } from '../src/repository.ts';
import { buildTestApp, type TestApp } from './app.ts';
import { startFakeUpstream, type UpstreamUser } from './fake-upstream.ts';
import { Browser } from './oidc.ts';

export const ISSUER = 'http://localhost:8080';
export const ADMIN = 'http://admin.localhost:8080';
const UPSTREAM_CLIENT = { clientId: 'ldacapi', clientSecret: 'upstream-secret' };
export const ALICE: UpstreamUser = { sub: 'alice@upstream', name: 'Alice' };
export const PEOPLE = 'arcp://name,people';

/** What turns sign-in on, against the upstream provider at `upstreamIssuer` */
const oidcEnv = (upstreamIssuer: string) => ({
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENTS: JSON.stringify([{ client_id: 'oni', redirect_uris: ['http://localhost:5173/callback'] }]),
  OIDC_UPSTREAM_ISSUER: upstreamIssuer,
  OIDC_UPSTREAM_CLIENT_ID: UPSTREAM_CLIENT.clientId,
  OIDC_UPSTREAM_CLIENT_SECRET: UPSTREAM_CLIENT.clientSecret,
});

/** The OCFL repository at `OCFL_ROOT` */
export const ocflRepository = (deps: Record<string, unknown>) => initRepository('ocfl', deps);

/** A repository of `crates`, each with its index state, recording what it is asked to do */
export const repositoryOf = (crates: { id: string; name?: string; state: Record<string, string> }[]) => {
  const fake = {
    storage: () => ({ content: {} }),
    async *objects() {
      for (const { id, name = id, state } of crates) {
        yield { id, name, path: '', state };
      }
    },
    getState: async (crateId: string) => crates.find(({ id }) => id === crateId)?.state ?? {},
    createIndex: vi.fn(async () => {}),
    deleteIndex: vi.fn(async () => {}),
  };
  return fake as unknown as Repository & Pick<typeof fake, 'createIndex' | 'deleteIndex'>;
};

/** A repository with one crate, `PEOPLE`, whose search index is in `state` */
export const repositoryIn = (state: string) => repositoryOf([{ id: PEOPLE, name: 'People', state: { structural: 'indexed', search: state } }]);

/** Runs a fake upstream provider for a file's tests, then closes it and every app started with `start` */
export const adminTestbed = () => {
  let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
  const running: Awaited<ReturnType<typeof buildTestApp>>[] = [];

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

  return {
    get upstream() {
      return upstream;
    },

    /** Builds the app with sign-in on, and `env` on top */
    async start(env: Record<string, string> = {}, options?: Parameters<typeof buildTestApp>[1]) {
      const started = await buildTestApp({ ...oidcEnv(upstream.issuer), ...env }, options);
      running.push(started);
      return started;
    },

    /** Signs `user` in to the admin pages in a new browser, returning the page it lands on */
    async signInAsAdmin(app: TestApp, user: UpstreamUser) {
      const browser = new Browser(app, ADMIN, ISSUER);
      const toUpstream = await browser.follow('/admin/');
      const page = await browser.follow(upstream.signIn(toUpstream.headers.location as string, user));
      return { browser, page };
    },
  };
};
