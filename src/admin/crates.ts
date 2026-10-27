import { type RepositoryObject, State } from '../repository.ts';
import { type Html, html } from './html.ts';

type Crate = RepositoryObject & { children: Crate[] };

const INDEXES = { structural: 'Structural', search: 'Search' } as const;

const IN_PROGRESS = new Set<string>([State.QUEUED, State.INDEXING, State.DELETING]);

/** How often the page reloads while an index is changing */
const REFRESH_SECONDS = 5;

/** The nearest crate whose id is a path prefix of `id`, as indexing a crate also indexes the crates under it */
const parentOf = (id: string, crates: Map<string, Crate>) => {
  let path = id.replace(/\/+$/, '');
  for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/')) {
    path = path.slice(0, slash);
    const parent = crates.get(path) ?? crates.get(`${path}/`);
    if (parent) {
      return parent;
    }
  }
};

const byName = (a: Crate, b: Crate) => (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id);

const buildTree = (objects: RepositoryObject[]) => {
  const crates = new Map(objects.map((object) => [object.id, { ...object, children: [] as Crate[] }]));
  const roots: Crate[] = [];
  for (const crate of crates.values()) {
    (parentOf(crate.id, crates)?.children ?? roots).push(crate);
  }
  const sort = (list: Crate[]): Crate[] => list.sort(byName).map((crate) => ({ ...crate, children: sort(crate.children) }));
  return sort(roots);
};

const renderCrates = (crates: Crate[]): Html => html`<ul>
${crates.map(
  (crate) => html`<li data-id="${crate.id}" data-name="${crate.name ?? crate.id}">
  <span class="crate-name">${crate.name ?? crate.id}</span> <code>${crate.id}</code>
  ${Object.entries(INDEXES).map(([index, label]) => html`<span class="index-state">${label}: ${crate.state[index] ?? 'not indexed'}</span> `)}
  ${crate.children.length > 0 && renderCrates(crate.children)}
</li>
`,
)}</ul>`;

/** The crates as a tree, and a refresh while any index is changing */
export const cratesPage = (objects: RepositoryObject[]) => {
  const changing = objects.some(({ state }) => Object.values(state).some((value) => value && IN_PROGRESS.has(value)));
  const body =
    objects.length === 0
      ? html`<p>The repository has no crates.</p>`
      : html`<p><input type="search" id="crate-filter" placeholder="Filter by name" aria-label="Filter crates by name"></p>
    <div id="crates">${renderCrates(buildTree(objects))}</div>`;
  return { head: changing ? html`<meta http-equiv="refresh" content="${REFRESH_SECONDS}">` : undefined, body };
};
