import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@opensearch-project/opensearch';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALICE, adminTestbed, ocflRepository, PEOPLE, repositoryIn } from '../../test/admin.ts';
import type { buildTestApp, TestApp, TestRepository } from '../../test/app.ts';
import type { Browser } from '../../test/oidc.ts';
import type { Repository } from '../repository.ts';

const BUNDLED = 'arcp://name,bundled';

const testbed = adminTestbed();
let storage: string;
let opensearch: Client;

const start = (repository: TestRepository) => testbed.start({ OCFL_ROOT: join(storage, 'ocfl'), ADMIN_USERS: ALICE.sub }, { repository });

const signIn = async (app: TestApp) => {
  const { browser, page } = await testbed.signInAsAdmin(app, ALICE);
  expect(page.statusCode).toBe(200);
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
});

afterAll(async () => {
  await opensearch?.close();
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
    ({ app, repository, prisma, config } = await start(ocflRepository));
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
  it.each([
    ['one crate', { crateId: PEOPLE, force: 'true' }, `Reindexing ${PEOPLE}`],
    ['every crate', {}, 'Indexing every crate'],
  ])('refuses to index %s while deleting is in progress', async (_, form, asked) => {
    const repository = repositoryIn('deleting');
    const { app } = await start(repository);
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
    const { app } = await start(repository);
    const browser = await signIn(app);

    for (const action of ['index', 'delete']) {
      expect((await browser.post(`/admin/${action}`, { crateId: PEOPLE, force: 'true' }, headers)).statusCode).toBe(403);
    }

    expect(repository.createIndex).not.toHaveBeenCalled();
    expect(repository.deleteIndex).not.toHaveBeenCalled();
    expect(flash((await browser.get('/admin/')).body)).toBeUndefined();
  });
});
