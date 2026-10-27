import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ALICE, adminTestbed, ocflRepository, PEOPLE, repositoryIn } from '../../test/admin.ts';
import type { TestApp, TestRepository } from '../../test/app.ts';
import type { Repository } from '../repository.ts';

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

const testbed = adminTestbed();
let storage: string;

const start = (repository: TestRepository) => testbed.start({ OCFL_ROOT: join(storage, 'ocfl'), ADMIN_USERS: ALICE.sub }, { repository });

const signIn = async (app: TestApp) => {
  const signedIn = await testbed.signInAsAdmin(app, ALICE);
  expect(signedIn.page.statusCode).toBe(200);
  return signedIn;
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
});

afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
});

describe('the crate tree', () => {
  let app: TestApp;
  let repository: Repository;

  beforeAll(async () => {
    ({ app, repository } = await start(ocflRepository));
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
    expect(script.body).toContain('sessionStorage');
  });
});

describe('refreshing while indexes change', () => {
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
