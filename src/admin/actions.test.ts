import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@opensearch-project/opensearch';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/app.ts';
import { startFakeUpstream, type UpstreamUser } from '../../test/fake-upstream.ts';
import { Browser } from '../../test/oidc.ts';
import type { Repository } from '../repository.ts';

const ISSUER = 'http://localhost:8080';
const UPSTREAM_CLIENT = { clientId: 'ldacapi', clientSecret: 'upstream-secret' };
const ALICE: UpstreamUser = { sub: 'alice@upstream', name: 'Alice' };

const BUNDLED = 'arcp://name,bundled';
const PEOPLE = 'arcp://name,people';

let storage: string;
let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
let opensearch: Client;
const running: Awaited<ReturnType<typeof buildTestApp>>[] = [];

const start = async (repository: Repository | 'ocfl') => {
  const started = await buildTestApp(
    {
      OCFL_ROOT: join(storage, 'ocfl'),
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENTS: JSON.stringify([{ client_id: 'oni', redirect_uris: ['http://localhost:5173/callback'] }]),
      OIDC_UPSTREAM_ISSUER: upstream.issuer,
      OIDC_UPSTREAM_CLIENT_ID: UPSTREAM_CLIENT.clientId,
      OIDC_UPSTREAM_CLIENT_SECRET: UPSTREAM_CLIENT.clientSecret,
      ADMIN_USERS: ALICE.sub,
    },
    { repository },
  );
  running.push(started);
  return started;
};

const signIn = async (app: TestApp) => {
  const browser = new Browser(app, ISSUER);
  const toUpstream = await browser.follow('/admin/');
  expect((await browser.follow(upstream.signIn(toUpstream.headers.location as string, ALICE))).statusCode).toBe(200);
  return browser;
};

/** Submits an action's form, as its button does, and follows the redirect back */
const act = async (browser: Browser, action: string, form: Record<string, string> = {}) => {
  const response = await browser.post(`/admin/${action}`, form);
  expect(response.statusCode).toBe(303);
  expect(response.headers.location).toBe('/admin/');
  return browser.get('/admin/');
};

const flash = (body: string) =>
  body
    .match(/<[^>]*role="status"[^>]*>([\s\S]*?)<\/[a-z]+>/)?.[1]
    ?.replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), 'ldacapi-actions-'));
  execFileSync('node', ['scripts/seed.ts'], { env: { ...process.env, OCFL_ROOT: join(storage, 'ocfl') }, stdio: 'ignore' });
  upstream = await startFakeUpstream(UPSTREAM_CLIENT);
});

afterAll(async () => {
  for (const { app, prisma } of running) {
    await app.close();
    await prisma.$disconnect();
  }
  await opensearch?.close();
  await upstream.close();
  await rm(storage, { recursive: true, force: true });
});

describe('index and delete actions', () => {
  let app: TestApp;
  let repository: Repository;
  let prisma: Awaited<ReturnType<typeof buildTestApp>>['prisma'];
  let entityIndex: string;

  const entityCount = (crateId: string) => prisma.entity.count({ where: { rootCollection: crateId } });

  const searchCount = async (crateId: string) => {
    await opensearch.indices.refresh({ index: entityIndex, ignore_unavailable: true });
    const { body } = await opensearch.count({ index: entityIndex, ignore_unavailable: true, body: { query: { term: { rootCollection: crateId } } } });
    return body.count;
  };

  const waitUntilIndexed = (...crateIds: string[]) =>
    vi.waitFor(
      async () => {
        for (const crateId of crateIds) {
          expect(await repository.getState(crateId)).toEqual({ structural: 'indexed', search: 'indexed' });
        }
      },
      { timeout: 10_000, interval: 100 },
    );

  beforeAll(async () => {
    let config: Awaited<ReturnType<typeof buildTestApp>>['config'];
    ({ app, repository, prisma, config } = await start('ocfl'));
    entityIndex = config.search.entityIndex;
    opensearch = new Client({ node: config.opensearchUrl });
  });

  beforeEach(async () => {
    await repository.deleteIndex();
  });

  it('indexes one crate', async () => {
    const browser = await signIn(app);

    const page = await act(browser, 'index', { crateId: BUNDLED });

    expect(flash(page.body)).toBe(`Indexing ${BUNDLED} has been queued.`);
    await waitUntilIndexed(BUNDLED);
    expect(await entityCount(BUNDLED)).toBeGreaterThan(0);
    expect(await searchCount(BUNDLED)).toBeGreaterThan(0);
    expect(await entityCount(PEOPLE)).toBe(0);
    expect(await searchCount(PEOPLE)).toBe(0);
  });

  it('refuses to index an indexed crate, asking for a reindex', async () => {
    const browser = await signIn(app);
    await act(browser, 'index', { crateId: BUNDLED });
    await waitUntilIndexed(BUNDLED);

    const page = await act(browser, 'index', { crateId: BUNDLED });

    expect(flash(page.body)).toBe(`Indexing ${BUNDLED} was refused: it is already indexed, so reindex it instead.`);
  });

  it('reindexes an indexed crate', async () => {
    const browser = await signIn(app);
    await act(browser, 'index', { crateId: BUNDLED });
    await waitUntilIndexed(BUNDLED);
    const entities = await entityCount(BUNDLED);
    const documents = await searchCount(BUNDLED);

    const page = await act(browser, 'index', { crateId: BUNDLED, force: 'true' });

    expect(flash(page.body)).toBe(`Reindexing ${BUNDLED} has been queued.`);
    await waitUntilIndexed(BUNDLED);
    expect(await entityCount(BUNDLED)).toBe(entities);
    expect(await searchCount(BUNDLED)).toBe(documents);
  });

  it('indexes every crate', async () => {
    const browser = await signIn(app);

    const page = await act(browser, 'index');

    expect(flash(page.body)).toBe('Indexing every crate has been queued.');
    await waitUntilIndexed(BUNDLED, PEOPLE);
  });

  it('deletes one crate’s indexes', async () => {
    const browser = await signIn(app);
    await act(browser, 'index');
    await waitUntilIndexed(BUNDLED, PEOPLE);

    const page = await act(browser, 'delete', { crateId: BUNDLED });

    expect(flash(page.body)).toBe(`Deleting the indexes of ${BUNDLED} has started.`);
    await vi.waitFor(async () => {
      expect(await entityCount(BUNDLED)).toBe(0);
      expect(await searchCount(BUNDLED)).toBe(0);
    });
    expect(await entityCount(PEOPLE)).toBeGreaterThan(0);
    expect(await searchCount(PEOPLE)).toBeGreaterThan(0);
  });

  it('deletes every index', async () => {
    const browser = await signIn(app);
    await act(browser, 'index');
    await waitUntilIndexed(BUNDLED, PEOPLE);

    const page = await act(browser, 'delete');

    expect(flash(page.body)).toBe('Deleting every index has started.');
    await vi.waitFor(async () => {
      expect(await prisma.entity.count()).toBe(0);
      expect(await searchCount(BUNDLED)).toBe(0);
      expect(await searchCount(PEOPLE)).toBe(0);
    });
  });

  it('shows the message once, so reloading doesn’t repeat the action', async () => {
    const browser = await signIn(app);
    await act(browser, 'index', { crateId: BUNDLED });

    const reloaded = await browser.get('/admin/');

    expect(reloaded.statusCode).toBe(200);
    expect(flash(reloaded.body)).toBeUndefined();
  });

  it('asks before deleting, by a script the page loads', async () => {
    const browser = await signIn(app);
    const page = await browser.get('/admin/');

    const deletes = [...page.body.matchAll(/<form [^>]*action="\/admin\/delete"[^>]*>/g)].map(([form]) => form);
    expect(deletes.length).toBeGreaterThan(1);
    for (const form of deletes) {
      expect(form).toMatch(/data-confirm="[^"]+"/);
    }
    expect((await browser.get('/admin/admin.js')).body).toMatch(/\[data-confirm\][\s\S]*confirm\(/);
  });
});

describe('protecting the actions', () => {
  /** A repository with one crate whose search index is in `state`, recording what it is asked to do */
  const repositoryIn = (state: string) => ({
    storage: () => ({ content: {} }),
    async *objects() {
      yield { id: PEOPLE, name: 'People', path: '', state: { structural: 'indexed', search: state } };
    },
    getState: async () => ({ structural: 'indexed', search: state }),
    createIndex: vi.fn(async () => {}),
    deleteIndex: vi.fn(async () => {}),
  });

  it.each([
    ['one crate', { crateId: PEOPLE, force: 'true' }, `Reindexing ${PEOPLE}`],
    ['every crate', {}, 'Indexing every crate'],
  ])('refuses to index %s while deleting is in progress', async (_, form, asked) => {
    const repository = repositoryIn('deleting');
    const { app } = await start(repository as unknown as Repository);
    const browser = await signIn(app);

    const page = await act(browser, 'index', form);

    expect(flash(page.body)).toBe(`${asked} was refused: deleting is in progress.`);
    expect(repository.createIndex).not.toHaveBeenCalled();
  });

  it.each([
    ['without an Origin', {}],
    ['from another origin', { origin: 'https://evil.example.org' }],
  ])('refuses a POST %s and changes nothing', async (_, headers) => {
    const repository = repositoryIn('indexed');
    const { app } = await start(repository as unknown as Repository);
    const browser = await signIn(app);

    for (const action of ['index', 'delete']) {
      expect((await browser.post(`/admin/${action}`, { crateId: PEOPLE, force: 'true' }, headers)).statusCode).toBe(403);
    }

    expect(repository.createIndex).not.toHaveBeenCalled();
    expect(repository.deleteIndex).not.toHaveBeenCalled();
    expect(flash((await browser.get('/admin/')).body)).toBeUndefined();
  });
});
