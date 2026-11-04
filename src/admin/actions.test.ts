import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALICE, adminTestbed, PEOPLE, repositoryIn, repositoryOf } from '../../test/admin.ts';
import { type buildTestApp, ocflRepository, ocflStorage, type TestApp, type TestRepository } from '../../test/app.ts';
import type { Browser } from '../../test/oidc.ts';
import type { rowIds as crateRowIds } from '../indexer/database.ts';
import type { countDocuments } from '../indexer/search.ts';
import { hasState, type Repository, State } from '../repository.ts';

const BUNDLED = 'arcp://name,bundled';
const EXTRA = `${PEOPLE}/extra`;
const PEOPLE_TOO = `${PEOPLE}2`;
const DISTRIBUTED_ROOT = 'arcp://name,distributed_root';
const CONTENT_RESTRICTED = 'arcp://name,distributed_content_restricted';
const METADATA_RESTRICTED = 'arcp://name,distributed_metadata_restricted';

const testbed = adminTestbed();
const { ocflRoot } = ocflStorage();

const start = (repository: TestRepository) => testbed.start({ OCFL_ROOT: ocflRoot(), ADMIN_USERS: ALICE.sub }, { repository });

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

describe('index and delete actions', () => {
  let app: TestApp;
  let repository: Repository;
  let prisma: Awaited<ReturnType<typeof buildTestApp>>['prisma'];
  let search: Awaited<ReturnType<typeof buildTestApp>>['search'];
  let rowIdsOfCrate: typeof crateRowIds;
  let countSearchDocuments: typeof countDocuments;

  /** The ids of the entity rows indexed from `crateIds`, sorted */
  const rowIds = async (...crateIds: string[]) => (await Promise.all(crateIds.map(rowIdsOfCrate))).flat().sort();

  const entityCount = async (crateId: string) => (await rowIds(crateId)).length;

  const searchCount = (ids: string[]) => countSearchDocuments(search, ids);

  /** Waits until no crate is queued, indexing or deleting, so an earlier action can't leak into the next */
  const waitUntilSettled = () =>
    vi.waitFor(
      async () => {
        const busy = (await Array.fromAsync(repository.objects())).filter(({ state }) => hasState(state, State.QUEUED, State.INDEXING, State.DELETING));
        expect(busy).toEqual([]);
      },
      { timeout: 10_000, interval: 100 },
    );

  const waitUntilIndexed = async (...crateIds: string[]) => {
    await waitUntilSettled();
    for (const crateId of crateIds) {
      expect(await repository.getState(crateId)).toEqual({ database: 'indexed', search: 'indexed' });
    }
  };

  beforeAll(async () => {
    ({ app, repository, prisma, search } = await start(ocflRepository));
    // Imported once the app has read its configuration
    ({ rowIds: rowIdsOfCrate } = await import('../indexer/database.ts'));
    ({ countDocuments: countSearchDocuments } = await import('../indexer/search.ts'));
  });

  beforeEach(async () => {
    await repository.deleteIndex();
  });

  afterEach(waitUntilSettled);

  it('indexes one crate', async () => {
    const browser = await signIn(app);

    const page = await act(browser, 'index', { crateId: BUNDLED });

    expect(flash(page.body)).toBe(`Indexing ${BUNDLED} has been queued.`);
    await waitUntilIndexed(BUNDLED);
    const ids = await rowIds(BUNDLED);
    expect(ids).toContain(BUNDLED);
    expect(await searchCount(ids)).toBe(ids.length);
    expect(await entityCount(PEOPLE)).toBe(0);
  });

  it('records the crate each entity row came from', async () => {
    const browser = await signIn(app);

    await act(browser, 'index');

    await waitUntilIndexed(BUNDLED, PEOPLE, DISTRIBUTED_ROOT, CONTENT_RESTRICTED, METADATA_RESTRICTED);
    const counts = await Promise.all([BUNDLED, PEOPLE, DISTRIBUTED_ROOT, CONTENT_RESTRICTED, METADATA_RESTRICTED].map(entityCount));
    expect(counts.every((count) => count > 0)).toBe(true);
    expect(counts.reduce((sum, count) => sum + count)).toBe(await prisma.entity.count());
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
    const ids = await rowIds(BUNDLED);

    const page = await act(browser, 'index', { crateId: BUNDLED, force: 'true' });

    expect(flash(page.body)).toBe(`Reindexing ${BUNDLED} has been queued.`);
    await waitUntilIndexed(BUNDLED);
    expect(await rowIds(BUNDLED)).toEqual(ids);
    expect(await searchCount(ids)).toBe(ids.length);
  });

  it.each([
    ['reindexes', 'index', { force: 'true' }, true],
    ['deletes', 'delete', {}, false],
  ])('%s one crate of a distributed collection, leaving the rest of it alone', async (_, action, form, kept) => {
    const browser = await signIn(app);
    await act(browser, 'index');
    await waitUntilIndexed(DISTRIBUTED_ROOT, CONTENT_RESTRICTED, METADATA_RESTRICTED);
    const ids = await rowIds(CONTENT_RESTRICTED);
    const siblings = await rowIds(DISTRIBUTED_ROOT, METADATA_RESTRICTED);

    await act(browser, action, { crateId: CONTENT_RESTRICTED, ...form });

    await waitUntilSettled();
    expect(await rowIds(CONTENT_RESTRICTED)).toEqual(kept ? ids : []);
    expect(await searchCount(ids)).toBe(kept ? ids.length : 0);
    expect(await rowIds(DISTRIBUTED_ROOT, METADATA_RESTRICTED)).toEqual(siblings);
    expect(await searchCount(siblings)).toBe(siblings.length);
  });

  it('indexes every crate', async () => {
    const browser = await signIn(app);

    const page = await act(browser, 'index');

    expect(flash(page.body)).toBe('Indexing every crate has been queued.');
    await waitUntilIndexed(BUNDLED, PEOPLE);
  });

  it('reindexes every crate', async () => {
    const browser = await signIn(app);
    await act(browser, 'index');
    await waitUntilIndexed(BUNDLED, PEOPLE);
    const entities = await entityCount(PEOPLE);

    const page = await act(browser, 'index', { force: 'true' });

    expect(flash(page.body)).toBe('Reindexing every crate has been queued.');
    await waitUntilIndexed(BUNDLED, PEOPLE);
    expect(await entityCount(PEOPLE)).toBe(entities);
  });

  it('refuses to index every crate again while indexing is in progress, and still indexes every crate', async () => {
    const browser = await signIn(app);
    await act(browser, 'index');

    const page = await act(browser, 'index');

    expect(flash(page.body)).toBe('Indexing every crate was refused: indexing is already in progress.');
    await waitUntilIndexed(BUNDLED, PEOPLE);
  });

  it('offers to reindex every crate beside indexing every crate', async () => {
    const page = await (await signIn(app)).get('/admin/');

    expect(page.body).toMatch(
      /<form method="post" action="\/admin\/index"[^>]*><input type="hidden" name="force" value="true"><button[^>]*>Reindex all<\/button>/,
    );
  });

  it('shows every crate in progress, and keeps refreshing, as soon as indexing is queued', async () => {
    const browser = await signIn(app);

    const page = await act(browser, 'index');

    expect(page.body).toMatch(/<meta http-equiv="refresh"/);
    expect(page.body).not.toContain('Database: not indexed');
    await waitUntilIndexed(BUNDLED, PEOPLE);
  });

  it('deletes one crate’s indexes, including its people and organisations', async () => {
    const browser = await signIn(app);
    await act(browser, 'index');
    await waitUntilIndexed(BUNDLED, PEOPLE);
    const ids = await rowIds(PEOPLE);
    expect(ids).toEqual(expect.arrayContaining([`${PEOPLE}/JohnSmith`, 'arcp://name,organisation/ldaca']));
    const others = await rowIds(BUNDLED);

    const page = await act(browser, 'delete', { crateId: PEOPLE });

    expect(flash(page.body)).toBe(`Deleting the indexes of ${PEOPLE} has started.`);
    await vi.waitFor(async () => {
      expect(await prisma.entity.count({ where: { id: { in: ids } } })).toBe(0);
      expect(await searchCount(ids)).toBe(0);
    });
    expect(await rowIds(BUNDLED)).toEqual(others);
    expect(await searchCount(others)).toBe(others.length);
  });

  it('keeps a crate’s database rows when deleting its search documents fails', async () => {
    const browser = await signIn(app);
    await act(browser, 'index');
    await waitUntilIndexed(BUNDLED, PEOPLE);
    const ids = await rowIds(PEOPLE);
    const remove = vi.spyOn(search, 'remove').mockRejectedValue(new Error('Search is down'));

    try {
      await act(browser, 'delete', { crateId: PEOPLE });
      await waitUntilSettled();
      expect(remove).toHaveBeenCalled();
    } finally {
      remove.mockRestore();
    }

    expect(await rowIds(PEOPLE)).toEqual(ids);
    expect(await searchCount(ids)).toBe(ids.length);
    expect(await repository.getState(PEOPLE)).toEqual({ database: 'indexed', search: 'indexed' });
  });

  it('deletes every index', async () => {
    const browser = await signIn(app);
    await act(browser, 'index');
    await waitUntilIndexed(BUNDLED, PEOPLE);
    const ids = await rowIds(BUNDLED, PEOPLE);

    const page = await act(browser, 'delete');

    expect(flash(page.body)).toBe('Deleting every index has started.');
    await vi.waitFor(async () => {
      expect(await prisma.entity.count()).toBe(0);
      expect(await searchCount(ids)).toBe(0);
    });
  });

  it('reads a crate’s state as it was, not as indexing later changes it', async () => {
    const indexing = repository.createIndex([BUNDLED]);
    const state = await repository.getState(BUNDLED);
    const read = { ...state };

    await indexing;

    expect(read).toEqual({ database: 'queued', search: 'queued' });
    expect(state).toEqual(read);
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

describe('which crates an action covers', () => {
  const crates = () =>
    repositoryOf([
      { id: PEOPLE, state: {} },
      { id: EXTRA, state: {} },
      { id: PEOPLE_TOO, state: {} },
    ]);

  it('indexes a crate and the crates under it, not crates whose id merely starts with its id', async () => {
    const repository = crates();
    const browser = await signIn((await start(repository)).app);

    await act(browser, 'index', { crateId: PEOPLE });

    expect(repository.createIndex).toHaveBeenCalledWith([PEOPLE, EXTRA], undefined, false);
  });

  it('deletes the same crates as indexing would', async () => {
    const repository = crates();
    const browser = await signIn((await start(repository)).app);

    const page = await act(browser, 'delete', { crateId: PEOPLE });

    expect(flash(page.body)).toBe(`Deleting the indexes of ${PEOPLE} and the crates under it has started.`);
    expect(repository.deleteIndex.mock.calls).toEqual([[PEOPLE], [EXTRA]]);
  });

  it.each(['index', 'delete'])('refuses to %s a crate that isn’t in the repository', async (action) => {
    const repository = crates();
    const browser = await signIn((await start(repository)).app);

    const page = await act(browser, action, { crateId: 'arcp://name,nobody' });

    expect(flash(page.body)).toMatch(/^(Indexing|Deleting the indexes of) arcp:\/\/name,nobody was refused: it was not found\.$/);
    expect(repository.createIndex).not.toHaveBeenCalled();
    expect(repository.deleteIndex).not.toHaveBeenCalled();
  });
});

describe('protecting the actions', () => {
  it('refuses to index a crate while a crate under it is being deleted', async () => {
    const repository = repositoryOf([
      { id: PEOPLE, state: {} },
      { id: EXTRA, state: { search: 'deleting' } },
    ]);
    const browser = await signIn((await start(repository)).app);

    const page = await act(browser, 'index', { crateId: PEOPLE });

    expect(flash(page.body)).toBe(`Indexing ${PEOPLE} was refused: deleting is in progress.`);
    expect(repository.createIndex).not.toHaveBeenCalled();
  });

  it.each([
    ['one crate', 'queued', { crateId: PEOPLE }, `Deleting the indexes of ${PEOPLE} and the crates under it`],
    ['one crate', 'indexing', { crateId: PEOPLE }, `Deleting the indexes of ${PEOPLE} and the crates under it`],
    ['every crate', 'indexing', {}, 'Deleting every index'],
  ])('refuses to delete %s while a crate it covers is %s', async (_, state, form, asked) => {
    const repository = repositoryOf([
      { id: PEOPLE, state: {} },
      { id: EXTRA, state: { database: state } },
    ]);
    const browser = await signIn((await start(repository)).app);

    const page = await act(browser, 'delete', form);

    expect(flash(page.body)).toBe(`${asked} was refused: indexing is in progress.`);
    expect(repository.deleteIndex).not.toHaveBeenCalled();
  });

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
    ['one crate', 'queued', { crateId: PEOPLE }, `Indexing ${PEOPLE}`],
    ['one crate', 'indexing', { crateId: PEOPLE, force: 'true' }, `Reindexing ${PEOPLE}`],
    ['every crate', 'indexing', {}, 'Indexing every crate'],
    ['every crate', 'queued', { force: 'true' }, 'Reindexing every crate'],
  ])('refuses to index %s while a crate it covers is %s', async (_, state, form, asked) => {
    const repository = repositoryOf([
      { id: PEOPLE, state: {} },
      { id: EXTRA, state: { search: state } },
    ]);
    const browser = await signIn((await start(repository)).app);

    const page = await act(browser, 'index', form);

    expect(flash(page.body)).toBe(`${asked} was refused: indexing is already in progress.`);
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
