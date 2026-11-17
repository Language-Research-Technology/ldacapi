import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ALICE, adminTestbed, PEOPLE } from '../../test/admin.ts';
import type { buildTestApp } from '../../test/app.ts';

const BUNDLED = 'arcp://name,bundled';
const EXTRA = 'arcp://name,people/extra';
const MORE = 'arcp://name,people/extra/more';
const EXTRA_NAME = '<script>alert(1)</script> Extra people';

type Node = { id: string; row: string; children: Node[] };

/** The crate tree as a browser sees it: nested `<li data-id>`, each with the text of its own row */
const crateTree = (body: string) => {
  const root: Node = { id: '', row: '', children: [] };
  const stack = [root];
  for (const match of body.matchAll(/<(\/?)li\b(?:[^>]*?\bdata-id="([^"]*)")?[^>]*>/g)) {
    if (match[1]) {
      stack.pop();
      continue;
    }
    const rest = body.slice((match.index ?? 0) + match[0].length);
    const node: Node = {
      id: (match[2] ?? '').replaceAll('&amp;', '&'),
      row: rest
        .slice(0, rest.search(/<\/?(ul|li)\b/))
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
      children: [],
    };
    stack.at(-1)?.children.push(node);
    stack.push(node);
  }
  return root.children.filter(({ id }) => id);
};

const shape = (nodes: Node[]): unknown[] => nodes.map(({ id, children }) => (children.length ? { id, children: shape(children) } : { id }));

const find = (nodes: Node[], id: string): Node | undefined => {
  for (const node of nodes) {
    const found = node.id === id ? node : find(node.children, id);
    if (found) {
      return found;
    }
  }
};

/** Crates per state, as the top of the page shows them */
const counts = (body: string) => Object.fromEntries([...body.matchAll(/data-state="([^"]+)">(\d+)</g)].map(([, state, count]) => [state, Number(count)]));

const testbed = adminTestbed();
let started: Awaited<ReturnType<typeof buildTestApp>>;

const page = async () => {
  const signedIn = await testbed.signInAsAdmin(started.app, ALICE);
  expect(signedIn.page.statusCode).toBe(200);
  return signedIn;
};

const A = 'arcp://name,a';
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000);
const FAILED_AT = new Date('2026-11-16T09:30:00Z');
const INDEXED_AT = new Date('2026-11-15T08:00:00Z');

/** Records crate `id` and its jobs as a worker would have left them */
const stage = async (id: string, name: string | null, record: { indexedVersion?: number } = {}, ...jobs: Record<string, unknown>[]) => {
  const indexed = record.indexedVersion ? { indexedAt: INDEXED_AT, entities: 12, files: 1 } : {};
  await started.prisma.crateRecord.create({ data: { id, name, ...record, ...indexed } });
  for (const job of jobs) {
    const running = job.status === 'running' && { startedAt: new Date() };
    const failed = job.status === 'failed' && { error: 'Error', failedAt: FAILED_AT };
    await started.prisma.indexJob.create({ data: { crateId: id, kind: 'index', ...running, ...failed, ...job } });
  }
};

beforeAll(async () => {
  started = await testbed.start({ ADMIN_USERS: ALICE.sub, LOG_LEVEL: 'silent' });
});

beforeEach(async () => {
  await started.emptyEverything();
});

describe('the crate tree', () => {
  beforeEach(async () => {
    await stage(BUNDLED, 'Bundled');
    await stage(PEOPLE, 'People');
    await stage(EXTRA, EXTRA_NAME);
    await stage(MORE, null);
  });

  it('lists every crate, with collections containing their objects', async () => {
    const { page: body } = await page();

    expect(shape(crateTree(body.body))).toEqual([{ id: BUNDLED }, { id: PEOPLE, children: [{ id: EXTRA, children: [{ id: MORE }] }] }]);
  });

  it('labels a crate by its id until its name is known', async () => {
    const { page: body } = await page();

    expect(find(crateTree(body.body), MORE)?.row).toMatch(new RegExp(`^${MORE} ${MORE} not indexed`));
  });

  it('shows a crate name containing HTML escaped', async () => {
    const { page: body } = await page();

    expect(find(crateTree(body.body), EXTRA)?.row).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Extra people');
    expect(body.body).not.toContain('<script>alert');
  });

  it('has a filter box run by a script the CSP allows', async () => {
    const { browser, page: body } = await page();

    expect(body.body).toMatch(/<input [^>]*type="search"/);
    expect(body.body).toContain('<script src="/admin/admin.js" defer></script>');
    expect(body.headers['content-security-policy']).toContain("script-src 'self'");
    const script = await browser.get('/admin/admin.js');
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toMatch(/javascript/);
    expect(script.body).toContain('sessionStorage');
  });
});

describe('each crate’s index state', () => {
  it.each<[string, Parameters<typeof stage>, string]>([
    ['not indexed', [A, 'A'], 'not indexed'],
    ['indexed', [A, 'A', { indexedVersion: 3 }], 'indexed v3, 2026-11-15 08:00 UTC, 12 entities, 1 file'],
    ['queued', [A, 'A', { indexedVersion: 3 }, {}], 'queued'],
    ['indexing', [A, 'A', {}, { status: 'running', startedAt: new Date('2026-11-16T10:00:00Z') }], 'indexing since 2026-11-16 10:00 UTC'],
    [
      'indexing with its stage and counter',
      [A, 'A', {}, { status: 'running', startedAt: new Date('2026-11-16T10:42:00Z'), stage: 'search index', done: 12_000, total: 30_000 }],
      'indexing search index, 12,000 of 30,000, since 2026-11-16 10:42 UTC',
    ],
    [
      'indexing at a stage with no counter',
      [A, 'A', {}, { status: 'running', startedAt: new Date('2026-11-16T10:42:00Z'), stage: 'deriving' }],
      'indexing deriving, since 2026-11-16 10:42 UTC',
    ],
    ['deleting', [A, 'A', {}, { kind: 'delete', status: 'running' }], 'deleting'],
    [
      'failed with its stage and the entity it was on',
      [A, 'A', {}, { status: 'failed', error: 'Error: bad row', stage: 'database index', failedOn: `${A}/object`, failedAt: FAILED_AT, attempts: 2 }],
      `failed Error: bad row (database index, on ${A}/object, 2026-11-16 09:30 UTC, attempt 2)`,
    ],
    [
      'failed',
      [A, 'A', { indexedVersion: 3 }, { status: 'failed', error: 'Error: no licence', failedAt: FAILED_AT, attempts: 1 }],
      'failed Error: no licence (2026-11-16 09:30 UTC, attempt 1)',
    ],
    ['queued after failing', [A, 'A', {}, { status: 'failed', error: 'Error: no licence', failedAt: FAILED_AT }, {}], 'queued'],
  ])('shows %s', async (_, staged, shown) => {
    await stage(...staged);

    const { page: body } = await page();

    expect(find(crateTree(body.body), A)?.row).toBe(`A ${A} ${shown} Index Reindex Delete`);
  });

  it('counts the crates in each state at the top of the page', async () => {
    await stage('arcp://name,a', 'A', { indexedVersion: 1 });
    await stage('arcp://name,b', 'B', { indexedVersion: 1 });
    await stage('arcp://name,c', 'C', {}, {});
    await stage('arcp://name,d', 'D', {}, { status: 'failed', error: 'Error' });

    const { page: body } = await page();

    expect(counts(body.body)).toEqual({ 'not indexed': 0, queued: 1, indexing: 0, deleting: 0, indexed: 2, failed: 1 });
  });

  it('says there are no crates listed until crates are indexed, offering to index them all', async () => {
    const { page: body } = await page();

    expect(body.body).toContain('No crates are listed yet.');
    expect(body.body).toMatch(/<button [^>]*>Index all<\/button>/);
  });
});

describe('refreshing while indexes change', () => {
  it.each([
    ['queued', {}],
    ['indexing', { status: 'running' }],
    ['deleting', { kind: 'delete' }],
  ])('refreshes the page while a crate is %s', async (state, job) => {
    await stage(PEOPLE, 'People', {}, job);

    const { page: body } = await page();

    expect(body.body).toMatch(/<meta http-equiv="refresh" content="\d+">/);
    expect(find(crateTree(body.body), PEOPLE)?.row).toContain(state);
  });

  it('does not refresh once every crate is settled', async () => {
    await stage(PEOPLE, 'People', { indexedVersion: 1 });
    await stage(BUNDLED, 'Bundled', {}, { status: 'failed', error: 'Error' });

    const { page: body } = await page();

    expect(body.body).not.toContain('http-equiv="refresh"');
  });
});

describe('a failure of deleting everything', () => {
  /** The banner's text, if the page shows one */
  const banner = (body: string) => body.match(/<p [^>]*id="delete-everything-failed"[^>]*>([^<]*)<\/p>/)?.[1];

  it.each([
    [{ stage: 'search index' }, 'Deleting everything failed: Error: search refused (search index, 2026-11-16 09:30 UTC)'],
    [{}, 'Deleting everything failed: Error: search refused (2026-11-16 09:30 UTC)'],
  ])('shows its error, stage and time above the crates, given %o', async (stage, shown) => {
    await started.prisma.indexJob.create({ data: { kind: 'delete', status: 'failed', error: 'Error: search refused', failedAt: FAILED_AT, ...stage } });

    const { page: body } = await page();

    expect(banner(body.body)).toBe(shown);
  });

  it('is not shown while deleting everything hasn’t failed', async () => {
    await stage(A, 'A', {}, { status: 'failed', error: 'Error' });

    const { page: body } = await page();

    expect(banner(body.body)).toBeUndefined();
  });
});

describe('the worker warning', () => {
  const WARNING = 'No worker running';

  it('shows when no worker has a heartbeat', async () => {
    const { page: body } = await page();

    expect(body.body).toContain(WARNING);
  });

  it('shows when every worker’s heartbeat is old', async () => {
    await started.prisma.indexWorker.create({ data: { id: 'gone', heartbeatAt: YESTERDAY } });

    const { page: body } = await page();

    expect(body.body).toContain(WARNING);
  });

  it('is gone while a worker’s heartbeat is fresh', async () => {
    await started.prisma.indexWorker.create({ data: { id: 'gone', heartbeatAt: YESTERDAY } });
    await started.prisma.indexWorker.create({ data: { id: 'alive', heartbeatAt: new Date() } });

    const { page: body } = await page();

    expect(body.body).not.toContain(WARNING);
  });
});
