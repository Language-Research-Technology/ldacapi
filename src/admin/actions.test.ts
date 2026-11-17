import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALICE, adminTestbed, PEOPLE } from '../../test/admin.ts';
import { type buildTestApp, ocflStorage } from '../../test/app.ts';
import { collection, crate, object, person } from '../../test/crate-builder.ts';
import type { Browser } from '../../test/oidc.ts';

const BUNDLED = 'arcp://name,bundled';

const testbed = adminTestbed();
const { ocflRoot } = ocflStorage({
  crates: [
    crate(collection(BUNDLED, { name: 'Bundled', hasMember: [`${BUNDLED}/object`] }), [object(`${BUNDLED}/object`, { memberOf: BUNDLED })]),
    crate(collection(PEOPLE, { name: 'People' }), [person('https://example.org/alice', { name: 'Alice' })]),
  ],
});

let started: Awaited<ReturnType<typeof buildTestApp>>;

const signIn = async () => {
  const { browser, page } = await testbed.signInAsAdmin(started.app, ALICE);
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

/** The text of the row of crate `id` */
const row = (body: string, id: string) =>
  body
    .match(new RegExp(`<li data-id="${id.replaceAll('.', '\\.')}"[\\s\\S]*?</li>`))?.[0]
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const jobs = () => started.prisma.indexJob.findMany({ select: { crateId: true, kind: true, status: true }, orderBy: { crateId: 'asc' } });

const searchableIds = async () => {
  const response = await started.app.inject({ method: 'POST', url: `${started.config.prefix}/search`, payload: { query: '', limit: 100 } });
  return response.json().entities.map(({ id }: { id: string }) => id);
};

beforeAll(async () => {
  started = await testbed.start({ OCFL_ROOT: ocflRoot(), ADMIN_USERS: ALICE.sub, LOG_LEVEL: 'silent' }, { ocfl: true });
});

beforeEach(async () => {
  await started.emptyEverything();
});

describe('asking for crates to be indexed', () => {
  it('queues a job for every crate, which shows indexed with its version and counts once a worker has run it', async () => {
    const browser = await signIn();

    const page = await act(browser, 'index');

    expect(flash(page.body)).toBe('Indexing every crate has been queued.');
    expect(await jobs()).toEqual([
      { crateId: BUNDLED, kind: 'index', status: 'waiting' },
      { crateId: PEOPLE, kind: 'index', status: 'waiting' },
    ]);
    expect(row(page.body, BUNDLED)).toContain('queued');
    expect(page.body).toMatch(/<meta http-equiv="refresh" content="\d+">/);

    await started.workTheQueue();

    const indexed = await browser.get('/admin/');
    expect(row(indexed.body, BUNDLED)).toMatch(/Bundled .*indexed v1, .* UTC, 2 entities, 0 files/);
    expect(row(indexed.body, PEOPLE)).toMatch(/People .*indexed v1, .* UTC, 2 entities, 0 files/);
    expect(indexed.body).not.toContain('http-equiv="refresh"');
    expect(await searchableIds()).toContain(`${BUNDLED}/object`);
  });

  it('only queues jobs: the worker writes the indexes', async () => {
    const browser = await signIn();

    await act(browser, 'index');

    expect(await started.prisma.entity.count()).toBe(0);
  });

  it.each([
    [{ crateId: BUNDLED }, 'index', `Indexing ${BUNDLED} has been queued.`],
    [{ crateId: BUNDLED, force: 'true' }, 'reindex', `Reindexing ${BUNDLED} has been queued.`],
  ])('queues one crate, given %o', async (form, kind, message) => {
    await started.indexQueue.index(BUNDLED);
    await started.workTheQueue();
    const browser = await signIn();

    const page = await act(browser, 'index', form);

    expect(flash(page.body)).toBe(message);
    expect(await jobs()).toEqual([{ crateId: BUNDLED, kind, status: 'waiting' }]);
  });

  it('reindexes every crate', async () => {
    const browser = await signIn();

    const page = await act(browser, 'index', { force: 'true' });

    expect(flash(page.body)).toBe('Reindexing every crate has been queued.');
    expect((await jobs()).map(({ kind }) => kind)).toEqual(['reindex', 'reindex']);
  });

  it('adds nothing when asked again while the crate waits', async () => {
    await started.indexQueue.index(BUNDLED);
    const browser = await signIn();

    await act(browser, 'index', { crateId: BUNDLED });

    expect(await jobs()).toEqual([{ crateId: BUNDLED, kind: 'index', status: 'waiting' }]);
  });

  it('carries on with a job once the API that asked for it has stopped', async () => {
    const browser = await signIn();
    await act(browser, 'index');
    const app = started.build();
    await app.close();

    await started.workTheQueue();

    expect(await started.indexQueue.crate(BUNDLED)).toMatchObject({ state: 'indexed', version: 1 });
  });

  it('shows the message once, so reloading doesn’t repeat the action', async () => {
    await started.indexQueue.index(BUNDLED);
    const browser = await signIn();
    await act(browser, 'index', { crateId: BUNDLED });

    const reloaded = await browser.get('/admin/');

    expect(reloaded.statusCode).toBe(200);
    expect(flash(reloaded.body)).toBeUndefined();
  });
});

describe('asking for a crate’s indexes to be deleted', () => {
  it('queues a delete, which leaves the crate listed as not indexed and unsearchable once a worker has run it', async () => {
    await started.indexQueue.index(BUNDLED);
    await started.workTheQueue();
    const browser = await signIn();

    const page = await act(browser, 'delete', { crateId: BUNDLED });

    expect(flash(page.body)).toBe(`Deleting the indexes of ${BUNDLED} has been queued.`);
    expect(row(page.body, BUNDLED)).toContain('deleting');

    await started.workTheQueue();

    expect(row((await browser.get('/admin/')).body, BUNDLED)).toContain('not indexed');
    expect(await searchableIds()).not.toContain(BUNDLED);
  });

  it('asks before deleting, by a script the page loads', async () => {
    await started.indexQueue.index(BUNDLED);
    await started.indexQueue.index(PEOPLE);
    const browser = await signIn();
    const page = await browser.get('/admin/');

    const deletes = [...page.body.matchAll(/<form [^>]*action="\/admin\/delete"[^>]*>/g)].map(([form]) => form);
    expect(deletes).toHaveLength(2);
    for (const form of deletes) {
      expect(form).toMatch(/data-confirm="[^"]+"/);
    }
    expect((await browser.get('/admin/admin.js')).body).toMatch(/\[data-confirm\][\s\S]*confirm\(/);
  });
});

describe('protecting the actions', () => {
  it.each(['index', 'delete'])('refuses to %s a crate that isn’t listed', async (action) => {
    const browser = await signIn();

    const page = await act(browser, action, { crateId: 'arcp://name,elsewhere' });

    expect(flash(page.body)).toMatch(/arcp:\/\/name,elsewhere was refused: it was not found\.$/);
    expect(await jobs()).toEqual([]);
  });

  it('refuses to delete every index', async () => {
    await started.indexQueue.index(BUNDLED);
    const browser = await signIn();

    const page = await act(browser, 'delete');

    expect(flash(page.body)).toBe('Deleting every index was refused: choose a crate to delete the indexes of.');
    expect((await jobs()).map(({ kind }) => kind)).toEqual(['index']);
  });

  it.each([
    ['without an Origin', {}],
    ['from another origin', { origin: 'https://evil.example.org' }],
  ])('refuses a POST %s and changes nothing', async (_, headers) => {
    const browser = await signIn();

    for (const action of ['index', 'delete']) {
      expect((await browser.post(`/admin/${action}`, { crateId: PEOPLE, force: 'true' }, headers)).statusCode).toBe(403);
    }

    expect(await jobs()).toEqual([]);
    expect(flash((await browser.get('/admin/')).body)).toBeUndefined();
  });
});
