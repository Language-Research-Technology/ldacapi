import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from '../../test/app.ts';
import { startFakeUpstream, type UpstreamUser } from '../../test/fake-upstream.ts';
import { Browser } from '../../test/oidc.ts';
import type { Repository } from '../repository.ts';

const ISSUER = 'http://localhost:8080';
const UPSTREAM_CLIENT = { clientId: 'ldacapi', clientSecret: 'upstream-secret' };
const ALICE: UpstreamUser = { sub: 'alice@upstream', name: 'Alice' };

const BUNDLED = 'arcp://name,bundled';
const PEOPLE = 'arcp://name,people';
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
  return root.children;
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

const crate = (id: string, name: string) => ({
  '@context': ['https://w3id.org/ro/crate/1.1/context', { '@vocab': 'http://schema.org/' }],
  '@graph': [
    { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': id } },
    { '@id': id, '@type': ['Dataset', 'RepositoryCollection'], name },
  ],
});

let storage: string;
let upstream: Awaited<ReturnType<typeof startFakeUpstream>>;
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
  const page = await browser.follow(upstream.signIn(toUpstream.headers.location as string, ALICE));
  expect(page.statusCode).toBe(200);
  return { browser, page };
};

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), 'ldacapi-crates-'));
  const source = join(storage, 'source');
  await mkdir(source);
  for (const name of ['bundled', 'people']) {
    await cp(resolve('test-data', name), join(source, name), { recursive: true });
  }
  for (const [directory, id, name] of [
    ['extra', EXTRA, EXTRA_NAME],
    ['more', MORE, 'More people'],
  ] as const) {
    await mkdir(join(source, directory));
    await writeFile(join(source, directory, 'ro-crate-metadata.json'), JSON.stringify(crate(id, name)));
  }
  execFileSync('node', ['scripts/seed.ts', source], { env: { ...process.env, OCFL_ROOT: join(storage, 'ocfl') }, stdio: 'ignore' });
  upstream = await startFakeUpstream(UPSTREAM_CLIENT);
});

afterAll(async () => {
  for (const { app, prisma } of running) {
    await app.close();
    await prisma.$disconnect();
  }
  await upstream.close();
  await rm(storage, { recursive: true, force: true });
});

describe('the crate tree', () => {
  let app: TestApp;
  let repository: Repository;

  beforeAll(async () => {
    ({ app, repository } = await start('ocfl'));
    await repository.deleteIndex();
  });

  it('lists every crate, with collections containing their objects', async () => {
    const { page } = await signIn(app);

    expect(shape(crateTree(page.body))).toEqual([{ id: BUNDLED }, { id: PEOPLE, children: [{ id: EXTRA, children: [{ id: MORE }] }] }]);
  });

  it('shows each crate’s real state for each index', async () => {
    const { browser } = await signIn(app);
    await repository.createIndex(new RegExp(`^${BUNDLED}$`));

    await vi.waitFor(async () => {
      const page = await browser.get('/admin/');
      const tree = crateTree(page.body);
      expect(find(tree, BUNDLED)?.row).toMatch(/Structural: indexed .*Search: indexed/);
      expect(find(tree, PEOPLE)?.row).toMatch(/Structural: not indexed .*Search: not indexed/);
      expect(page.body).not.toContain('http-equiv="refresh"');
    });
  });

  it('shows a crate name containing HTML escaped', async () => {
    const { page } = await signIn(app);

    expect(find(crateTree(page.body), EXTRA)?.row).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Extra people');
    expect(page.body).not.toContain('<script>alert');
  });

  it('has a filter box run by a script the CSP allows', async () => {
    const { browser, page } = await signIn(app);

    expect(page.body).toMatch(/<input [^>]*type="search"/);
    expect(page.body).toContain('<script src="/admin/admin.js" defer></script>');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    const script = await browser.get('/admin/admin.js');
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toMatch(/javascript/);
  });
});

describe('refreshing while indexes change', () => {
  /** A repository whose one crate is in `state` for the search index */
  const repositoryIn = (state: string) =>
    ({
      storage: () => ({ content: {} }),
      async *objects() {
        yield { id: PEOPLE, name: 'People', path: '', state: { structural: 'indexed', search: state } };
      },
    }) as unknown as Repository;

  it.each(['queued', 'indexing', 'deleting'])('refreshes the page while an index is %s', async (state) => {
    const { app } = await start(repositoryIn(state));

    const { page } = await signIn(app);

    expect(page.body).toMatch(/<meta http-equiv="refresh" content="\d+">/);
    expect(find(crateTree(page.body), PEOPLE)?.row).toContain(`Search: ${state}`);
  });

  it('does not refresh once every index is settled', async () => {
    const { app } = await start(repositoryIn('indexed'));

    const { page } = await signIn(app);

    expect(page.body).not.toContain('http-equiv="refresh"');
  });
});
